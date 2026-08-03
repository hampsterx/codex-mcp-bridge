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
import { readCodexConfig, listMcpServers } from "../utils/codex-config.js";
import {
  DEGRADED_LIST_MS,
  classifyServers,
  mergeStartupNotifications,
  nextCursorStep,
  parseListedServer,
  type ListedServer,
  type McpServerReport,
} from "../utils/mcp-status.js";

/** Hard ceiling on the notification drain in diagnostics mode. */
const DRAIN_DEADLINE_MS = 60_000;

/** Fallback quiet window, used only after every expected server reported. */
const DRAIN_QUIET_MS = 3_000;

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
): Promise<{ timedOut: boolean }> {
  const started = Date.now();
  let lastStartupAt = Date.now();

  const unsubscribe = session.onNotification((n) => {
    if (n.method === "mcpServer/startupStatus/updated") lastStartupAt = Date.now();
  });

  try {
    for (;;) {
      const merged = mergeStartupNotifications(session.getNotifications(), threadId);
      const allReported =
        expected.size > 0 && [...expected].every((name) => merged.has(name));
      if (allReported) return { timedOut: false };

      // Nothing expected has arrived for a while and the stream has gone
      // quiet: give up rather than block on a server that never reports.
      if (merged.size > 0 && Date.now() - lastStartupAt > DRAIN_QUIET_MS) {
        return { timedOut: true };
      }
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
      incompleteReason = `mcpServerStatus/list failed: ${JSON.stringify(response.error)}`;
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
    await session.request("initialize", {
      clientInfo: { name: "codex-mcp-bridge", version: "0" },
      capabilities: { experimentalApi: true },
    });
    session.notify("initialized", {});

    if (diagnostics) {
      // `ephemeral: true` keeps the thread off disk (verified: thread.path
      // comes back null). No turn is submitted, so there is no token cost.
      const started = await session.request("thread/start", { ephemeral: true });
      const result = (started.result ?? {}) as Record<string, unknown>;
      const thread = (result["thread"] ?? {}) as Record<string, unknown>;
      // The id lives at params.thread.id, not params.threadId.
      threadId = typeof thread["id"] === "string" ? thread["id"] : null;
    }

    // Fetch the inventory first so the drain has a real expected set: config
    // alone misses built-ins like `codex_apps`, which is reported by the
    // app-server but absent from config.toml.
    const inventory = await fetchInventory(session, threadId);
    if (inventory.incompleteReason) incompleteReason = inventory.incompleteReason;

    let drainTimedOut = false;
    if (diagnostics) {
      const expected = new Set<string>([
        ...configured,
        ...inventory.servers.map((s) => s.name),
      ]);
      const drained = await drainNotifications(
        session,
        threadId,
        expected,
        DRAIN_DEADLINE_MS,
      );
      drainTimedOut = drained.timedOut;
      if (drainTimedOut && !incompleteReason) {
        incompleteReason = "not every server reported a terminal startup state before the deadline";
      }
    }

    const degraded = inventory.durationMs > DEGRADED_LIST_MS;
    const merged = mergeStartupNotifications(session.getNotifications(), threadId);

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
      codexVersion: readCodexVersion(),
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
