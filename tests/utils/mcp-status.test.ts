import { describe, it, expect } from "vitest";
import {
  DEGRADED_LIST_MS,
  MAX_PAGES,
  classifyServers,
  mergeStartupNotifications,
  nextCursorStep,
  parseListedServer,
  redactError,
  type ListedServer,
} from "../../src/utils/mcp-status.js";

const THREAD = "019fc4f1-70d0-7db2-8b01-1a649b1ccc72";

/** Shorthand for a startup notification. */
function note(
  name: string,
  status: string,
  extra: Record<string, unknown> = {},
): { method: string; params: Record<string, unknown> } {
  return {
    method: "mcpServer/startupStatus/updated",
    params: { name, status, threadId: THREAD, ...extra },
  };
}

/**
 * The real four-notification, two-round boot recorded on codex-cli 0.146.0.
 * Healthy servers emit `cancelled` for their superseded round-1 attempt
 * BEFORE their eventual `ready`.
 */
const TWO_ROUND_CAPTURE = [
  note("serena", "starting"),
  note("ck-search", "starting"),
  note("ck-search", "failed", {
    error: "MCP client for `ck-search` failed to start: MCP startup failed: No such file or directory (os error 2)",
  }),
  note("serena", "starting"),
  note("serena", "cancelled"),
  note("ck-search", "starting"),
  note("ck-search", "failed", {
    error: "MCP client for `ck-search` failed to start: MCP startup failed: No such file or directory (os error 2)",
  }),
  note("serena", "ready"),
];

describe("mergeStartupNotifications", () => {
  it("keeps ready over an earlier cancelled from the superseded boot round", () => {
    const merged = mergeStartupNotifications(TWO_ROUND_CAPTURE, THREAD);
    expect(merged.get("serena")?.status).toBe("ready");
  });

  it("keeps failed and its diagnostic text", () => {
    const merged = mergeStartupNotifications(TWO_ROUND_CAPTURE, THREAD);
    expect(merged.get("ck-search")?.status).toBe("failed");
    expect(merged.get("ck-search")?.error).toContain("No such file or directory");
  });

  it("ignores cancelled regardless of arrival order", () => {
    // Reordered so `cancelled` arrives last. A "last non-starting wins" rule
    // would report cancelled here; ignoring cancelled outright must not.
    const reordered = [note("serena", "starting"), note("serena", "ready"), note("serena", "cancelled")];
    const merged = mergeStartupNotifications(reordered, THREAD);
    expect(merged.get("serena")?.status).toBe("ready");
  });

  it("never yields starting or cancelled as a state", () => {
    const merged = mergeStartupNotifications(
      [note("a", "starting"), note("a", "cancelled")],
      THREAD,
    );
    expect(merged.has("a")).toBe(false);
  });

  it("quarantines notifications from a different thread", () => {
    const merged = mergeStartupNotifications(
      [note("a", "ready", { threadId: "other-thread" })],
      THREAD,
    );
    expect(merged.has("a")).toBe(false);
  });

  it("quarantines notifications with a null threadId", () => {
    const merged = mergeStartupNotifications(
      [note("a", "ready", { threadId: null })],
      THREAD,
    );
    expect(merged.has("a")).toBe(false);
  });

  it("ignores unrelated notification methods", () => {
    const merged = mergeStartupNotifications(
      [{ method: "thread/started", params: { name: "a", status: "ready" } }],
      THREAD,
    );
    expect(merged.size).toBe(0);
  });

  it("takes the last terminal state when a server reports twice", () => {
    const merged = mergeStartupNotifications(
      [note("a", "failed", { error: "first" }), note("a", "ready")],
      THREAD,
    );
    expect(merged.get("a")?.status).toBe("ready");
  });
});

describe("redactError", () => {
  it("keeps a remediation URL, which is the actionable part", () => {
    const text =
      "MCP client for `slack` failed to start: App is not enabled for Slack MCP server access. " +
      "Please enable it here: https://api.slack.com/apps/A0B0K6CP19D/app-assistant";
    expect(redactError(text)).toContain("https://api.slack.com/apps/");
  });

  it("redacts a bearer token in the diagnostic text", () => {
    const out = redactError("failed: Bearer abcdefghijklmnopqrstuvwxyz012345");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts an API key in the diagnostic text", () => {
    const out = redactError("failed with sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("parseListedServer", () => {
  it("treats tools as a map keyed by tool name, not an array", () => {
    const parsed = parseListedServer({
      name: "serena",
      authStatus: "unsupported",
      tools: { find_symbol: {}, replace_content: {} },
      resources: [],
      serverInfo: { name: "serena", version: "1" },
    });
    expect(parsed?.tools).toEqual(["find_symbol", "replace_content"]);
    expect(parsed?.hasServerInfo).toBe(true);
  });

  it("reports an absent serverInfo without inventing a failure", () => {
    const parsed = parseListedServer({
      name: "sentry",
      authStatus: "oAuth",
      tools: {},
      resources: [],
    });
    expect(parsed?.hasServerInfo).toBe(false);
    expect(parsed?.tools).toEqual([]);
  });

  it("rejects malformed entries", () => {
    expect(parseListedServer(null)).toBeNull();
    expect(parseListedServer({ authStatus: "oAuth" })).toBeNull();
  });
});

function listed(over: Partial<ListedServer> & { name: string }): ListedServer {
  return {
    authStatus: "unsupported",
    tools: [],
    resourceCount: 0,
    hasServerInfo: false,
    ...over,
  };
}

describe("classifyServers", () => {
  it("never reports failed without an explicit notification", () => {
    const reports = classifyServers({
      listed: [listed({ name: "sentry", hasServerInfo: false })],
      merged: new Map(),
      configuredNames: ["sentry"],
      diagnostics: false,
      degraded: false,
    });
    expect(reports[0]?.state).toBe("unknown");
    expect(reports.some((r) => r.state === "failed")).toBe(false);
  });

  it("reports failed only from the notification, carrying the error", () => {
    const reports = classifyServers({
      listed: [listed({ name: "sentry" })],
      merged: new Map([["sentry", { status: "failed" as const, error: "invalid_grant" }]]),
      configuredNames: ["sentry"],
      diagnostics: true,
      degraded: false,
    });
    expect(reports[0]?.state).toBe("failed");
    expect(reports[0]?.error).toBe("invalid_grant");
  });

  it("trusts the notification over the inventory when they disagree", () => {
    // The observed flake: a slow list reports a ready server as uninitialized.
    const reports = classifyServers({
      listed: [listed({ name: "playwright", hasServerInfo: false, tools: [] })],
      merged: new Map([["playwright", { status: "ready" as const }]]),
      configuredNames: ["playwright"],
      diagnostics: true,
      degraded: true,
    });
    expect(reports[0]?.state).toBe("initialized");
    expect(reports[0]?.note).toContain("uninitialized");
  });

  it("flags a degraded snapshot on an unknown server", () => {
    const reports = classifyServers({
      listed: [listed({ name: "serena", hasServerInfo: false })],
      merged: new Map(),
      configuredNames: ["serena"],
      diagnostics: false,
      degraded: true,
    });
    expect(reports[0]?.note).toContain("degraded");
  });

  it("classifies an unconfigured reported server as a built-in, by category", () => {
    const reports = classifyServers({
      listed: [
        listed({ name: "codex_apps", hasServerInfo: true, tools: ["a"] }),
        listed({ name: "serena", hasServerInfo: true, tools: ["b"] }),
      ],
      merged: new Map(),
      configuredNames: ["serena"],
      diagnostics: false,
      degraded: false,
    });
    const builtIn = reports.find((r) => r.name === "codex_apps");
    expect(builtIn?.origin).toBe("builtIn");
    expect(reports.find((r) => r.name === "serena")?.origin).toBe("configured");
  });

  it("surfaces a configured server the app-server never reported", () => {
    const reports = classifyServers({
      listed: [],
      merged: new Map(),
      configuredNames: ["ghost"],
      diagnostics: true,
      degraded: false,
    });
    expect(reports[0]?.origin).toBe("configuredButUnreported");
    expect(reports[0]?.state).toBe("unknown");
  });

  it("keeps a server that emitted no terminal notification, as unknown", () => {
    const reports = classifyServers({
      listed: [listed({ name: "silent", hasServerInfo: false })],
      merged: new Map(),
      configuredNames: ["silent"],
      diagnostics: true,
      degraded: false,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.state).toBe("unknown");
    expect(reports[0]?.note).toContain("no terminal startup notification");
  });

  it("counts tools from the inventory", () => {
    const reports = classifyServers({
      listed: [listed({ name: "linear", hasServerInfo: true, tools: ["a", "b", "c"] })],
      merged: new Map(),
      configuredNames: ["linear"],
      diagnostics: false,
      degraded: false,
    });
    expect(reports[0]?.toolCount).toBe(3);
    expect(reports[0]?.state).toBe("initialized");
  });
});

describe("nextCursorStep", () => {
  it("stops on a null or absent cursor", () => {
    expect(nextCursorStep(null, new Set(), 0).next).toBeNull();
    expect(nextCursorStep(undefined, new Set(), 0).next).toBeNull();
    expect(nextCursorStep("", new Set(), 0).next).toBeNull();
  });

  it("follows a fresh cursor", () => {
    const seen = new Set<string>();
    expect(nextCursorStep("page2", seen, 0).next).toBe("page2");
    expect(seen.has("page2")).toBe(true);
  });

  it("stops and reports when a cursor repeats", () => {
    const seen = new Set(["page2"]);
    const step = nextCursorStep("page2", seen, 1);
    expect(step.next).toBeNull();
    expect(step.incompleteReason).toContain("repeated");
  });

  it("breaks an A->B->A cycle", () => {
    const seen = new Set<string>();
    expect(nextCursorStep("A", seen, 0).next).toBe("A");
    expect(nextCursorStep("B", seen, 1).next).toBe("B");
    const step = nextCursorStep("A", seen, 2);
    expect(step.next).toBeNull();
    expect(step.incompleteReason).toContain("repeated");
  });

  it("stops at the page cap and says so", () => {
    const step = nextCursorStep("more", new Set(), MAX_PAGES - 1);
    expect(step.next).toBeNull();
    expect(step.incompleteReason).toContain("cap");
  });
});

describe("DEGRADED_LIST_MS", () => {
  it("sits between the fastest bad run and the slowest clean run observed", () => {
    // Spike measurements: clean runs topped out at 13.0s, bad runs started at 35.8s.
    expect(DEGRADED_LIST_MS).toBeGreaterThan(13_000);
    expect(DEGRADED_LIST_MS).toBeLessThan(35_800);
  });
});
