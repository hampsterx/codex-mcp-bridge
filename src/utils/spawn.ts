import { spawn, type ChildProcess } from "node:child_process";
import { buildSubprocessEnv } from "./env.js";

/** Hard maximum timeout — no request can exceed this. */
const HARD_TIMEOUT_CAP = 600_000; // 10 minutes

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
let activeCount = 0;
const maxConcurrent = parseInt(
  process.env["CODEX_MAX_CONCURRENT"] ?? String(DEFAULT_MAX_CONCURRENT),
  10,
);

const waitQueue: Array<{
  resolve: () => void;
  reject: (err: Error) => void;
}> = [];

function acquireSlot(): Promise<void> {
  if (activeCount < maxConcurrent) {
    activeCount++;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.findIndex((w) => w.resolve === resolve);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(new Error(`Concurrency queue timeout after ${QUEUE_TIMEOUT}ms — ${activeCount} processes active`));
    }, QUEUE_TIMEOUT);

    waitQueue.push({
      resolve: () => {
        clearTimeout(timer);
        activeCount++;
        resolve();
      },
      reject,
    });
  });
}

function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) {
    next.resolve();
  }
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
 * Reset concurrency state (for testing).
 */
export function resetConcurrency(): void {
  activeCount = 0;
  waitQueue.length = 0;
}
