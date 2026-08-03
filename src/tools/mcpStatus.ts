/**
 * MCP boot introspection: report what Codex's own app-server says about each
 * configured MCP server.
 *
 * Two sequences, per PLAN_MCP_BOOT_INTROSPECTION.md § Route:
 *
 *   A (default):     initialize -> initialized -> mcpServerStatus/list
 *   B (diagnostics): adds thread/start -> drain notifications -> list
 *
 * A is ~6s and creates no thread. B costs 19-47s and creates an ephemeral
 * thread, and is the only route to an explicit `failed` verdict plus the
 * free-form error text that names the actual cause.
 */

import { execFileSync } from "node:child_process";
import { AppServerSession } from "../utils/app-server.js";
import { findCodexBinary } from "../utils/spawn.js";
import {
  readCodexConfig,
  listMcpServers,
  listMcpServerEnvValues,
} from "../utils/codex-config.js";
import {
  DEGRADED_LIST_MS,
  classifyServers,
  mergeStartupNotifications,
  nextCursorStep,
  parseListedServer,
  redactError,
  serversStillStarting,
  type ListedServer,
  type McpServerReport,
  type MergedNotification,
} from "../utils/mcp-status.js";

/** Hard ceiling on the notification drain in diagnostics mode. */
const DRAIN_DEADLINE_MS = 60_000;

/**
 * Silence that ends the drain when some expected server never reported.
 *
 * Must exceed the largest real gap between startup notifications, or a slow
 * healthy server is cut off and reported `unknown`. The spike's widest gap was
 * ~5.8s (last `starting` wave at ~1.4s, slowest terminal at 7.2s), so this
 * leaves room. The list call already runs first and absorbs 6-9s of that.
 */
const DRAIN_QUIET_MS = 10_000;

/**
 * Quiet required after every expected server has settled.
 *
 * Small on purpose. The correctness work is done by `serversStillStarting`,
 * which knows a server is mid-boot rather than inferring it from silence, so a
 * round-1 terminal cannot be mistaken for an answer while round 2 is in
 * flight. This window only absorbs the gap between a terminal notification and
 * an immediate follow-up; widening it to cover the slowest possible boot would
 * charge that cost to every call.
 */
const DRAIN_SETTLE_MS = 1_500;

export interface McpStatusInput {
  /**
   * Run the diagnostic sequence: start an ephemeral thread and collect
   * startup notifications. Slower, and the only source of `failed` + error.
   */
  diagnostics?: boolean;
  workingDirectory?: string;
  timeout?: number;
}

export interface McpStatusResult {
  servers: McpServerReport[];
  /** How long `mcpServerStatus/list` took, the confidence signal. */
  listDurationMs: number;
  /** Set when the list was slow enough that `unknown` states are suspect. */
  degraded: boolean;
  /** Set when pagination or the drain could not complete. */
  incomplete: boolean;
  incompleteReason?: string;
  diagnostics: boolean;
  threadId: string | null;
  codexVersion: string | null;
  pageCount: number;
  totalDurationMs: number;
}

function readCodexVersion(): string | null {
  try {
    return execFileSync(findCodexBinary(), ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Literal credential values from `[mcp_servers.NAME.env]`, for redaction.
 * Read once per invocation; see `listMcpServerEnvValues` for why these cannot
 * be found in `process.env`.
 */
function configuredEnvSecrets(): string[] {
  try {
    return listMcpServerEnvValues(readCodexConfig());
  } catch {
    return [];
  }
}

function configuredServerNames(): string[] {
  // config.toml directly, not `codex mcp list --json`: synchronous, no
  // subprocess, and it sidesteps that command's undocumented schema and its
  // snake_case/camelCase mismatch with the app-server.
  try {
    return listMcpServers(readCodexConfig()).map((s) => s.name);
  } catch {
    return [];
  }
}

/**
 * Wait for every expected server to report a terminal state.
 *
 * Termination is driven by the expected set under a hard deadline, NOT by
 * "nothing is `starting`" — at ~1.4s into a real session every server has
 * emitted `cancelled` or `failed` and none is `starting`, which would report
 * a fully healthy fleet as cancelled. The quiet window is only a fallback for
 * servers that never announce themselves at all.
 */
async function drainNotifications(
  session: AppServerSession,
  threadId: string | null,
  expected: ReadonlySet<string>,
  deadlineMs: number,
  extraSecrets: readonly string[],
): Promise<{ timedOut: boolean }> {
  // Nothing to wait for. Without this the loop would burn the full deadline
  // when the inventory failed and no servers are configured.
  if (expected.size === 0) return { timedOut: false };
  // Without a thread, no notification can be attributed to this session, so
  // waiting is guaranteed to be wasted time (the merge returns empty by
  // construction). The caller already records why the thread is missing.
  if (threadId === null) return { timedOut: true };

  const started = Date.now();
  let lastStartupAt = Date.now();

  // Only startup notifications reset the window. Resetting on any traffic
  // would let a chatty session defer completion indefinitely.
  const unsubscribe = session.onNotification((n) => {
    if (n.method === "mcpServer/startupStatus/updated") lastStartupAt = Date.now();
  });

  try {
    for (;;) {
      // Only reached on the diagnostic path, which always has a thread.
      const notifications = session.getNotifications();
      const merged = mergeStartupNotifications(notifications, threadId, extraSecrets);
      const starting = serversStillStarting(notifications, threadId);
      // A server whose most recent notification is `starting` is mid-boot, so
      // its merged terminal is a stale round-1 value, not an answer.
      const allReported = [...expected].every(
        (name) => merged.has(name) && !starting.has(name),
      );
      const quietFor = Date.now() - lastStartupAt;

      // Complete once nothing is in flight and the stream has settled briefly,
      // so a round-2 state supersedes its round-1 predecessor before close.
      if (allReported && quietFor > DRAIN_SETTLE_MS) return { timedOut: false };

      // Some server never reported and the stream has gone silent. Give up
      // rather than block, but only after a window wider than any real
      // inter-notification gap, so a slow healthy server is not cut off.
      if (quietFor > DRAIN_QUIET_MS) return { timedOut: true };
      if (Date.now() - started > deadlineMs) return { timedOut: true };

      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    unsubscribe();
  }
}

/** Page through `mcpServerStatus/list`, following cursors defensively. */
async function fetchInventory(
  session: AppServerSession,
  threadId: string | null,
  extraSecrets: readonly string[],
): Promise<{
  servers: ListedServer[];
  pageCount: number;
  durationMs: number;
  incompleteReason?: string;
}> {
  const started = Date.now();
  const servers: ListedServer[] = [];
  const seenCursors = new Set<string>();
  const seenNames = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  let incompleteReason: string | undefined;

  for (let page = 0; ; page++) {
    const params: Record<string, unknown> = { detail: "toolsAndAuthOnly" };
    if (cursor) params["cursor"] = cursor;
    if (threadId) params["threadId"] = threadId;

    const response = await session.request("mcpServerStatus/list", params);
    if (response.error) {
      // Redacted for the same reason the notification error is: this is
      // free-form text from the same child, and a failing server can echo a
      // credential back into it.
      incompleteReason = `mcpServerStatus/list failed: ${redactError(JSON.stringify(response.error), extraSecrets)}`;
      break;
    }
    pageCount++;

    const result = (response.result ?? {}) as Record<string, unknown>;
    const data = result["data"];
    if (!Array.isArray(data)) {
      incompleteReason = "mcpServerStatus/list returned no 'data' array";
      break;
    }
    for (const raw of data) {
      const parsed = parseListedServer(raw);
      // Duplicate names across pages would double-count; first wins.
      if (parsed && !seenNames.has(parsed.name)) {
        seenNames.add(parsed.name);
        servers.push(parsed);
      }
    }

    const step = nextCursorStep(result["nextCursor"], seenCursors, page);
    if (step.incompleteReason) incompleteReason = step.incompleteReason;
    if (!step.next) break;
    cursor = step.next;
  }

  return {
    servers,
    pageCount,
    durationMs: Date.now() - started,
    ...(incompleteReason ? { incompleteReason } : {}),
  };
}

export async function executeMcpStatus(
  input: McpStatusInput = {},
): Promise<McpStatusResult> {
  const startedAt = Date.now();
  const diagnostics = input.diagnostics === true;
  const configured = configuredServerNames();
  const extraSecrets = configuredEnvSecrets();
  // Read before opening the session: execFileSync blocks for up to 10s, and
  // inside the try it would hold the concurrency slot for that whole time
  // after all real work is done.
  const codexVersion = readCodexVersion();

  const session = new AppServerSession({
    ...(input.workingDirectory ? { cwd: input.workingDirectory } : {}),
    ...(input.timeout ? { requestTimeout: input.timeout } : {}),
  });

  let threadId: string | null = null;
  let incompleteReason: string | undefined;

  try {
    await session.open();

    // `experimentalApi` is not required (verified: the methods are ungated on
    // 0.146.0) but it is the documented opt-in for experimental fields.
    const init = await session.request("initialize", {
      clientInfo: { name: "codex-mcp-bridge", version: "0" },
      capabilities: { experimentalApi: true },
    });
    if (init.error) {
      // Nothing downstream is meaningful if the handshake was refused.
      throw new Error(
        `codex app-server rejected initialize: ${redactError(JSON.stringify(init.error), extraSecrets)}`,
      );
    }
    session.notify("initialized", {});

    if (diagnostics) {
      // `ephemeral: true` keeps the thread off disk (verified: thread.path
      // comes back null). No turn is submitted, so there is no token cost.
      const started = await session.request("thread/start", { ephemeral: true });
      const result = (started.result ?? {}) as Record<string, unknown>;
      const thread = (result["thread"] ?? {}) as Record<string, unknown>;
      // The id lives at params.thread.id, not params.threadId.
      threadId = typeof thread["id"] === "string" ? thread["id"] : null;
      if (threadId === null) {
        // Say so rather than silently degrading to the inventory-only answer:
        // without a thread there are no notifications, so no server can be
        // reported `failed` and the caller would not otherwise know why.
        incompleteReason = started.error
          ? `thread/start failed, so no diagnostic states are available: ${redactError(JSON.stringify(started.error), extraSecrets)}`
          : "thread/start returned no thread id, so no diagnostic states are available";
      }
    }

    // Fetch the inventory first so the drain has a real expected set: config
    // alone misses built-ins like `codex_apps`, which is reported by the
    // app-server but absent from config.toml.
    const inventory = await fetchInventory(session, threadId, extraSecrets);
    if (inventory.incompleteReason) incompleteReason = inventory.incompleteReason;

    let drainTimedOut = false;
    if (diagnostics) {
      // Only servers Codex actually reports can emit startup notifications.
      // Including configured-but-unreported names (a `enabled = false` entry,
      // or a stale one) makes the all-reported condition unsatisfiable, so
      // every call would burn the full quiet timeout and report `incomplete`
      // for a config that is merely normal. Those names are still surfaced,
      // by classifyServers, as `configuredButUnreported`.
      const expected = new Set<string>(inventory.servers.map((s) => s.name));
      const drained = await drainNotifications(
        session,
        threadId,
        expected,
        DRAIN_DEADLINE_MS,
        extraSecrets,
      );
      drainTimedOut = drained.timedOut;
      if (drainTimedOut && !incompleteReason) {
        incompleteReason = "not every server reported a terminal startup state before the deadline";
      }
    }

    const degraded = inventory.durationMs > DEGRADED_LIST_MS;
    // Only the diagnostic path has a thread, and only a thread can attribute
    // notifications. mergeStartupNotifications enforces this too; gating here
    // as well keeps the default path's "never reports failed" contract local
    // and obvious.
    const merged = diagnostics
      ? mergeStartupNotifications(session.getNotifications(), threadId, extraSecrets)
      : new Map<string, MergedNotification>();

    const servers = classifyServers({
      listed: inventory.servers,
      merged,
      configuredNames: configured,
      diagnostics,
      degraded,
    });

    return {
      servers,
      listDurationMs: inventory.durationMs,
      degraded,
      incomplete: incompleteReason !== undefined,
      ...(incompleteReason ? { incompleteReason } : {}),
      diagnostics,
      threadId,
      codexVersion,
      pageCount: inventory.pageCount,
      totalDurationMs: Date.now() - startedAt,
    };
  } finally {
    session.close();
  }
}

/** Render the result as the text body of the MCP tool response. */
export function formatMcpStatus(result: McpStatusResult): string {
  const lines: string[] = [];

  if (result.degraded) {
    lines.push(
      `WARNING: mcpServerStatus/list took ${result.listDurationMs}ms (threshold ${DEGRADED_LIST_MS}ms). ` +
        `Slow calls have been observed reporting healthy servers as uninitialized, so treat "unknown" below as unproven.`,
      "",
    );
  }
  if (result.incomplete && result.incompleteReason) {
    lines.push(`INCOMPLETE: ${result.incompleteReason}`, "");
  }

  const width = Math.max(4, ...result.servers.map((s) => s.name.length));
  for (const s of result.servers) {
    const bits = [
      s.name.padEnd(width),
      s.state.padEnd(11),
      `auth=${s.authStatus ?? "n/a"}`,
      `tools=${s.toolCount}`,
    ];
    if (s.origin !== "configured") bits.push(`(${s.origin})`);
    lines.push(bits.join("  "));
    if (s.error) lines.push(`    error: ${s.error}`);
    if (s.note) lines.push(`    note: ${s.note}`);
  }

  lines.push("");
  lines.push(
    `${result.servers.length} server(s), list ${result.listDurationMs}ms, total ${result.totalDurationMs}ms` +
      `${result.diagnostics ? "" : " — run with diagnostics:true for explicit failure states and error text"}`,
  );
  if (result.codexVersion) lines.push(`codex: ${result.codexVersion}`);

  return lines.join("\n");
}
