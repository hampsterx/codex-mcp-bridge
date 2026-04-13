import { spawn, type ChildProcess } from "node:child_process";
import { buildSubprocessEnv } from "./env.js";

/** Hard maximum timeout — no request can exceed this. */
export const HARD_TIMEOUT_CAP = 600_000; // 10 minutes

/** Default max concurrent subprocess spawns. */
const DEFAULT_MAX_CONCURRENT = 3;

/** Queue timeout — how long a request waits for a slot. */
const QUEUE_TIMEOUT = 30_000;

export interface SpawnOptions {
  args: string[];
  cwd: string;
  stdin?: string;
  timeout?: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

// Concurrency management

/**
 * Resolve max concurrency from an explicit override or CODEX_MAX_CONCURRENT.
 * Rejects zero, negative, and non-integer values — all of which would
 * deadlock acquireSlot (activeCount < 0/NaN is always false) — and falls
 * back to the default.
 */
function readMaxConcurrent(override?: number): number {
  if (typeof override === "number") {
    return Number.isInteger(override) && override > 0
      ? override
      : DEFAULT_MAX_CONCURRENT;
  }

  const parsed = Number.parseInt(
    process.env["CODEX_MAX_CONCURRENT"] ?? String(DEFAULT_MAX_CONCURRENT),
    10,
  );

  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT;
}

let activeCount = 0;
let maxConcurrent = readMaxConcurrent();

interface WaitEntry {
  grant: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const waitQueue: WaitEntry[] = [];

/**
 * Acquire a concurrency slot. Resolves immediately if under the limit,
 * otherwise queues until a slot is released or the queue timeout fires.
 * Exported for diagnostics and tests.
 */
export function acquireSlot(queueTimeoutMs: number = QUEUE_TIMEOUT): Promise<void> {
  if (activeCount < maxConcurrent) {
    activeCount++;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const entry: WaitEntry = {
      grant: () => {},
      reject,
      timer: setTimeout(() => {
        const idx = waitQueue.indexOf(entry);
        if (idx !== -1) waitQueue.splice(idx, 1);
        reject(
          new Error(
            `Concurrency queue timeout after ${queueTimeoutMs}ms — ${activeCount} processes active`,
          ),
        );
      }, queueTimeoutMs),
    };

    entry.grant = () => {
      clearTimeout(entry.timer);
      activeCount++;
      resolve();
    };

    waitQueue.push(entry);
  });
}

/**
 * Release a concurrency slot. If a waiter is queued, hand the slot to it.
 * Exported for diagnostics and tests.
 */
export function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) {
    next.grant();
  }
}

/** Read the current active count. Exported for diagnostics and tests. */
export function getActiveCount(): number {
  return activeCount;
}

/** Read the current queue depth. Exported for diagnostics and tests. */
export function getQueueDepth(): number {
  return waitQueue.length;
}

/** Read the configured max concurrency. Exported for diagnostics. */
export function getMaxConcurrent(): number {
  return maxConcurrent;
}

/**
 * Find the Codex CLI binary path.
 */
export function findCodexBinary(): string {
  return process.env["CODEX_CLI_PATH"] ?? "codex";
}

/**
 * Spawn a Codex CLI subprocess with hardened environment,
 * timeout management, and concurrency limiting.
 */
export async function spawnCodex(options: SpawnOptions): Promise<SpawnResult> {
  const timeout = Math.min(options.timeout ?? 60_000, HARD_TIMEOUT_CAP);

  await acquireSlot();

  try {
    return await doSpawn(options, timeout);
  } finally {
    releaseSlot();
  }
}

async function doSpawn(options: SpawnOptions, timeout: number): Promise<SpawnResult> {
  const binary = findCodexBinary();
  const env = buildSubprocessEnv();

  return new Promise<SpawnResult>((resolve, reject) => {
    let child: ChildProcess;
    const detached = process.platform !== "win32";
    try {
      child = spawn(binary, options.args, {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached,
      });
    } catch (e) {
      reject(new Error(`Failed to spawn Codex CLI: ${e}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      killTimer = killProcessGroup(child);
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              "Codex CLI not found. Install with: npm i -g @openai/codex",
            ),
          );
        } else {
          reject(new Error(`Failed to run Codex CLI: ${err.message}`));
        }
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: code, timedOut });
      }
    });

    // Write stdin if provided, then close
    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

/**
 * Kill a process and its children. SIGTERM first, SIGKILL after grace period.
 * Only uses process group kill (-pid) when the child was spawned with detached: true.
 */
function killProcessGroup(child: ChildProcess): NodeJS.Timeout | undefined {
  const pid = child.pid;
  if (!pid) return undefined;

  const useGroupKill = process.platform !== "win32";

  const kill = (signal: NodeJS.Signals) => {
    try {
      if (useGroupKill) {
        process.kill(-pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already dead
      }
    }
  };

  kill("SIGTERM");

  // Force kill after 5s grace
  return setTimeout(() => kill("SIGKILL"), 5000);
}

/**
 * Reset concurrency state (for testing). Optionally override maxConcurrent;
 * called without an argument, restores the env-derived default so stale
 * overrides from prior tests cannot leak across suites. Rejects any pending
 * waiters and clears their queue-timeout timers so the event loop drains
 * cleanly between tests.
 */
export function resetConcurrency(newMaxConcurrent?: number): void {
  activeCount = 0;
  while (waitQueue.length > 0) {
    const entry = waitQueue.shift()!;
    clearTimeout(entry.timer);
    entry.reject(new Error("Concurrency state reset"));
  }
  maxConcurrent = readMaxConcurrent(newMaxConcurrent);
}
