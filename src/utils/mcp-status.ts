/**
 * Pure logic for MCP boot introspection: notification merging, server
 * classification, and the configured-vs-reported diff.
 *
 * Kept free of process and I/O concerns so the awkward parts (the two-round
 * boot, the `cancelled` wave, the `serverInfo` flake) are unit-testable
 * against recorded fixtures.
 */

import { redactSecrets } from "./parse.js";

/**
 * Above this list duration, `serverInfo` absence stops being trustworthy.
 *
 * Measured over 12 spike runs on codex-cli 0.146.0: every run at or under
 * 13.0s reported `serverInfo` correctly for all 12 servers, and every run at
 * or above 35.8s reported at least one explicitly-`ready` server as
 * uninitialized. The threshold sits inside that gap, nearer the clean end,
 * because a false "degraded" is cheap and a false "failed" is not.
 */
export const DEGRADED_LIST_MS = 15_000;

/** Hard cap on cursor pages, to bound a misbehaving or cyclic paginator. */
export const MAX_PAGES = 50;

/** Notifications with no thread id go here rather than into the live thread. */
export const NULL_THREAD_KEY = "__null_thread__";

export type StartupStatus = "starting" | "ready" | "failed" | "cancelled";

/**
 * What we are willing to assert about a server.
 *
 * `failed` is reserved for an explicit `failed` notification. An absent
 * `serverInfo` yields `unknown`, never `failed`: the spike caught the list
 * reporting healthy servers as uninitialized on 3 of 12 runs.
 */
export type ServerState = "initialized" | "failed" | "unknown";

/** Where a server came from, once the list is diffed against config.toml. */
export type ServerOrigin =
  | "configured"
  | "builtIn"
  | "configuredButUnreported";

/** One server as reported by `mcpServerStatus/list`. */
export interface ListedServer {
  name: string;
  authStatus: string;
  tools: string[];
  resourceCount: number;
  hasServerInfo: boolean;
}

/** A merged terminal state for one server, derived from notifications. */
export interface MergedNotification {
  status: StartupStatus;
  error?: string;
}

export interface McpServerReport {
  name: string;
  authStatus: string | null;
  toolCount: number;
  tools: string[];
  resourceCount: number;
  state: ServerState;
  origin: ServerOrigin;
  /** Present only when the diagnostic (thread) path ran. */
  startupStatus?: StartupStatus;
  /** Redacted diagnostic text from the notification. */
  error?: string;
  /** Set when the list and the notifications disagreed for this server. */
  note?: string;
}

/**
 * Reduce raw startup notifications to one state per server.
 *
 * Rules, all bought with live captures:
 *
 *  - Servers boot in TWO rounds per thread, so each emits roughly
 *    `starting`, `starting`, `cancelled`, `ready|failed` (four, not two).
 *  - `cancelled` belongs to the superseded round-1 attempt and arrives
 *    BEFORE the real terminal state for healthy servers. Keeping "the last
 *    non-`starting` state" or "the first terminal state" both report a
 *    fully healthy fleet as cancelled.
 *  - So: ignore `starting` and `cancelled` outright, and keep the
 *    last-arriving `ready|failed`. Ignoring `cancelled` on arrival (rather
 *    than relying on ordering) also makes the result order-independent.
 *  - Notifications carry a nullable `threadId`. Anything not matching the
 *    session's thread is quarantined rather than merged.
 *
 * `notifications` must already be in arrival order.
 */
export function mergeStartupNotifications(
  notifications: ReadonlyArray<{ method: string; params?: Record<string, unknown> }>,
  threadId: string | null,
): Map<string, MergedNotification> {
  const merged = new Map<string, MergedNotification>();

  for (const n of notifications) {
    if (n.method !== "mcpServer/startupStatus/updated") continue;
    const params = n.params ?? {};
    const name = params["name"];
    const status = params["status"];
    if (typeof name !== "string" || typeof status !== "string") continue;

    const rawThread = params["threadId"];
    const thread = typeof rawThread === "string" ? rawThread : NULL_THREAD_KEY;
    // Quarantine: only the session's own thread contributes. A null or
    // foreign threadId is dropped rather than polluting the live bucket.
    if (threadId !== null && thread !== threadId) continue;

    if (status === "starting" || status === "cancelled") continue;
    if (status !== "ready" && status !== "failed") continue;

    const error = params["error"];
    merged.set(name, {
      status,
      ...(typeof error === "string" && error.length > 0
        ? { error: redactError(error) }
        : {}),
    });
  }

  return merged;
}

/**
 * Redact credentials from a free-form startup error.
 *
 * Remediation URLs are deliberately KEPT. The live capture's most useful
 * failure text was a Slack console link telling the operator exactly how to
 * fix the server; stripping URLs wholesale would throw that away. Credentials
 * embedded in a URL are still caught by the shared secret patterns.
 */
export function redactError(text: string): string {
  return redactSecrets(text);
}

/**
 * Join the list inventory to the merged notifications and the configured set.
 *
 * The notification wins any disagreement, because the list's `serverInfo` is
 * the unreliable side. A disagreement is surfaced in `note` rather than
 * silently resolved.
 */
export function classifyServers(options: {
  listed: readonly ListedServer[];
  merged: Map<string, MergedNotification>;
  configuredNames: readonly string[];
  /** True when the diagnostic (thread) path ran and notifications are meaningful. */
  diagnostics: boolean;
  degraded: boolean;
}): McpServerReport[] {
  const { listed, merged, configuredNames, diagnostics, degraded } = options;
  const configured = new Set(configuredNames);
  const reports: McpServerReport[] = [];

  for (const server of listed) {
    const note: string[] = [];
    const notification = merged.get(server.name);

    let state: ServerState;
    if (notification?.status === "failed") {
      state = "failed";
    } else if (notification?.status === "ready") {
      state = "initialized";
      if (!server.hasServerInfo) {
        // The observed flake. Trust the notification, say so out loud.
        note.push(
          "inventory reported this server as uninitialized while its startup notification said ready; " +
            "tool list may be incomplete",
        );
      }
    } else if (server.hasServerInfo) {
      state = "initialized";
      if (diagnostics) {
        note.push("no terminal startup notification was received");
      }
    } else {
      // No serverInfo and no notification verdict. Never call this failed.
      state = "unknown";
      note.push(
        diagnostics
          ? "no serverInfo in the inventory and no terminal startup notification"
          : "no serverInfo in this snapshot; run with diagnostics for an explicit verdict",
      );
      if (degraded) {
        note.push("result is degraded, so this may be a slow-call artifact rather than a real failure");
      }
    }

    reports.push({
      name: server.name,
      authStatus: server.authStatus,
      toolCount: server.tools.length,
      tools: server.tools,
      resourceCount: server.resourceCount,
      state,
      origin: configured.has(server.name) ? "configured" : "builtIn",
      ...(notification ? { startupStatus: notification.status } : {}),
      ...(notification?.error ? { error: notification.error } : {}),
      ...(note.length > 0 ? { note: note.join("; ") } : {}),
    });
  }

  // Configured but never reported by the app-server. Distinct from failure.
  const reportedNames = new Set(listed.map((s) => s.name));
  for (const name of configuredNames) {
    if (reportedNames.has(name)) continue;
    reports.push({
      name,
      authStatus: null,
      toolCount: 0,
      tools: [],
      resourceCount: 0,
      state: "unknown",
      origin: "configuredButUnreported",
      note: "declared in config.toml but absent from the app-server inventory",
    });
  }

  return reports.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse one `McpServerStatus` entry into the shape the reports need. */
export function parseListedServer(raw: unknown): ListedServer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = r["name"];
  if (typeof name !== "string") return null;

  const tools = r["tools"];
  const resources = r["resources"];
  const authStatus = r["authStatus"];

  return {
    name,
    authStatus: typeof authStatus === "string" ? authStatus : "unknown",
    // `tools` is a MAP keyed by tool name, not an array.
    tools:
      typeof tools === "object" && tools !== null && !Array.isArray(tools)
        ? Object.keys(tools as Record<string, unknown>).sort()
        : [],
    resourceCount: Array.isArray(resources) ? resources.length : 0,
    // MCP requires serverInfo in a successful initialize result, so its
    // presence means "initialized in this snapshot". It is NOT a health bit.
    hasServerInfo: r["serverInfo"] !== undefined && r["serverInfo"] !== null,
  };
}

export interface CursorStep {
  /** Cursor to send on the next page, or null when done. */
  next: string | null;
  /** Set when pagination had to stop early. */
  incompleteReason?: string;
}

/**
 * Decide whether to follow a cursor, guarding against a paginator that
 * repeats, cycles, or never terminates. Never observed live (every capture
 * returned a single page), so this path is fixture-tested only.
 */
export function nextCursorStep(
  rawCursor: unknown,
  seen: Set<string>,
  pageIndex: number,
): CursorStep {
  if (typeof rawCursor !== "string" || rawCursor.length === 0) {
    return { next: null };
  }
  if (seen.has(rawCursor)) {
    return { next: null, incompleteReason: `pagination cursor repeated after ${pageIndex + 1} page(s)` };
  }
  if (pageIndex + 1 >= MAX_PAGES) {
    return { next: null, incompleteReason: `pagination stopped at the ${MAX_PAGES}-page cap` };
  }
  seen.add(rawCursor);
  return { next: rawCursor };
}
