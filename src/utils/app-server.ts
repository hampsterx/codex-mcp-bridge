/**
 * Streaming JSONL client for `codex app-server`.
 *
 * This is deliberately NOT built on `spawnCodex`. That path closes stdin
 * immediately (`spawn.ts`) and buffers stdout into one string until `close`,
 * which is the opposite of what app-server needs: stdin held open for the
 * life of the session, stdout parsed line-by-line, requests correlated to
 * responses by `id`, and notifications interleaved throughout.
 *
 * The protocol is JSON-RPC-shaped but omits `jsonrpc`, and `initialize`
 * requires only `clientInfo`. It is marked experimental upstream, so treat
 * every shape here as version-bound to the `codexVersion` recorded alongside
 * any cached result.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { buildIntrospectionEnv } from "./env.js";
import { acquireSlot, releaseSlot, findCodexBinary } from "./spawn.js";

/** Per-request timeout. The list call blocks while servers initialize. */
const DEFAULT_REQUEST_TIMEOUT = 90_000;

/** Grace period between SIGTERM and SIGKILL when tearing the child down. */
const KILL_GRACE_MS = 5_000;

interface PendingRequest {
  resolve: (msg: AppServerResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AppServerResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

export interface AppServerNotification {
  method: string;
  params?: Record<string, unknown>;
  /** Milliseconds since session start, for drain bookkeeping. */
  at: number;
}

export interface AppServerSessionOptions {
  /** Working directory for the child. Defaults to the bridge's cwd. */
  cwd?: string;
  /** Per-request timeout in milliseconds. */
  requestTimeout?: number;
}

/**
 * One live `codex app-server` child.
 *
 * Holds a concurrency slot for its whole lifetime, exactly like `spawnCodex`,
 * so an introspection session competes with `query` / `search` / `review`.
 * Always call `close()` in a `finally`; the slot is released exactly once.
 */
export class AppServerSession {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: AppServerNotification[] = [];
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private slotHeld = false;
  private startedAt = 0;
  private spawnError: Error | undefined;
  private readonly requestTimeout: number;
  private readonly cwd: string;

  /** Listeners fired on every notification, used by the drain loop. */
  private readonly listeners = new Set<(n: AppServerNotification) => void>();

  constructor(options: AppServerSessionOptions = {}) {
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.cwd = options.cwd ?? process.cwd();
  }

  /** Milliseconds since the child was spawned. */
  elapsed(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }

  /** Every notification received so far, in arrival order. */
  getNotifications(): readonly AppServerNotification[] {
    return this.notifications;
  }

  onNotification(fn: (n: AppServerNotification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Spawn the child and acquire a concurrency slot. */
  async open(): Promise<void> {
    if (this.child) throw new Error("app-server session already open");

    await acquireSlot();
    this.slotHeld = true;
    this.startedAt = Date.now();

    try {
      this.child = spawn(findCodexBinary(), ["app-server"], {
        cwd: this.cwd,
        env: buildIntrospectionEnv(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      this.releaseSlotOnce();
      throw new Error(`Failed to spawn codex app-server: ${String(e)}`);
    }

    this.child.on("error", (err: NodeJS.ErrnoException) => {
      this.spawnError =
        err.code === "ENOENT"
          ? new Error("Codex CLI not found. Install with: npm i -g @openai/codex")
          : new Error(`codex app-server failed: ${err.message}`);
      this.failAllPending(this.spawnError);
    });

    // A child that exits mid-session must not leave callers hanging.
    this.child.on("close", () => {
      this.failAllPending(
        this.spawnError ?? new Error("codex app-server exited before responding"),
      );
    });

    // A child that has already exited turns the next stdin write into an
    // EPIPE 'error' event on the socket. Unhandled, that is an uncaught
    // exception which would take down the whole bridge process, not just this
    // session. Pending callers are already failed by the 'close' handler.
    this.child.stdin?.on("error", () => {});

    this.child.stdout?.on("data", (chunk: Buffer) => this.ingest(chunk.toString()));
    // Drained but unused: app-server writes diagnostics here and a full pipe
    // buffer would block the child.
    this.child.stderr?.on("data", () => {});
  }

  /** Parse newline-delimited JSON, tolerating chunk boundaries mid-line. */
  private ingest(text: string): void {
    this.buffer += text;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Non-JSON banner lines are not fatal.
      }

      const id = msg["id"];
      if (typeof id === "number" && ("result" in msg || "error" in msg)) {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.resolve(msg as unknown as AppServerResponse);
        }
        continue;
      }

      if (typeof msg["method"] === "string") {
        const n: AppServerNotification = {
          method: msg["method"],
          params: (msg["params"] as Record<string, unknown>) ?? {},
          at: this.elapsed(),
        };
        this.notifications.push(n);
        for (const fn of this.listeners) fn(n);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a request and await its response, matched by `id`. */
  request(method: string, params: unknown = {}): Promise<AppServerResponse> {
    if (this.closed) return Promise.reject(new Error("session is closed"));
    if (!this.child) return Promise.reject(new Error("session is not open"));

    const id = this.nextId++;
    return new Promise<AppServerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the pending entry so a late response cannot resolve a caller
        // that has already given up.
        this.pending.delete(id);
        reject(new Error(`codex app-server: '${method}' timed out after ${this.requestTimeout}ms`));
      }, this.requestTimeout);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child?.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`codex app-server: failed to send '${method}': ${String(e)}`));
      }
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params: unknown = {}): void {
    if (this.closed || !this.child) return;
    try {
      this.child.stdin?.write(`${JSON.stringify({ method, params })}\n`);
    } catch {
      // The child is gone; pending requests are failed by the close handler.
    }
  }

  /**
   * Terminate the child and release the slot. Idempotent.
   *
   * Force-killing can bypass Codex's own cleanup of its MCP children, so
   * SIGTERM is given a grace period first. On POSIX the child is spawned
   * detached, so the whole process group is signalled and MCP grandchildren
   * go with it.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.failAllPending(new Error("session closed"));

    const child = this.child;
    if (child) {
      try {
        child.stdin?.end();
      } catch {
        // stdin may already be gone.
      }
      const pid = child.pid;
      const signal = (sig: NodeJS.Signals): void => {
        try {
          if (pid && process.platform !== "win32") process.kill(-pid, sig);
          else child.kill(sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            // Already dead.
          }
        }
      };
      signal("SIGTERM");
      const killTimer = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
      // Never hold the event loop open just to force-kill a child.
      killTimer.unref?.();
      child.once("close", () => clearTimeout(killTimer));
    }

    this.releaseSlotOnce();
  }

  private releaseSlotOnce(): void {
    if (!this.slotHeld) return;
    this.slotHeld = false;
    releaseSlot();
  }
}
