import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Protocol drift guard for `codex app-server`.
 *
 * The app-server protocol is marked experimental upstream, so the shapes
 * `src/utils/mcp-status.ts` parses can move under us on a CLI upgrade.
 *
 * A committed fixture compared against itself would pass forever, which is
 * no guard at all. So this regenerates the schema from the *installed* CLI
 * and diffs the MCP subset against the fixture. It skips when the CLI is
 * absent (CI without codex, contributor machines), which means the real
 * protection is a CI job that installs the pinned codex-cli and runs it.
 */

const FIXTURE = join(process.cwd(), "tests", "fixtures", "appserver-mcp-schema.json");

/** Definitions the bridge actually parses. Drift in these breaks the tool. */
const TRACKED = [
  "ListMcpServerStatusParams",
  "ListMcpServerStatusResponse",
  "McpServerStatus",
  "McpServerStatusDetail",
  "McpAuthStatus",
  "McpServerStartupState",
  "McpServerStartupFailureReason",
  "McpServerStatusUpdatedNotification",
  "McpServerInfo",
] as const;

function codexAvailable(): boolean {
  try {
    execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe("app-server protocol drift", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

  it("fixture pins every definition the bridge parses", () => {
    for (const name of TRACKED) {
      expect(fixture[name], `${name} missing from fixture`).toBeTruthy();
    }
  });

  it("fixture still encodes the facts the implementation relies on", () => {
    // tools is a MAP keyed by tool name, not an array. Parsing it as an array
    // silently yields toolCount 0 for every healthy server.
    const status = fixture["McpServerStatus"] as Record<string, never>;
    const tools = (status["properties"] as Record<string, Record<string, unknown>>)["tools"];
    expect(tools["type"]).toBe("object");
    expect(tools["additionalProperties"]).toBeTruthy();

    // The four startup states, including the transient `cancelled`.
    expect((fixture["McpServerStartupState"] as Record<string, unknown>)["enum"]).toEqual([
      "starting", "ready", "failed", "cancelled",
    ]);

    // camelCase auth values; the `codex mcp list --json` side is snake_case.
    expect((fixture["McpAuthStatus"] as Record<string, unknown>)["enum"]).toEqual([
      "unsupported", "notLoggedIn", "bearerToken", "oAuth",
    ]);

    // threadId is nullable on notifications, which is why the merge quarantines it.
    const notif = fixture["McpServerStatusUpdatedNotification"] as Record<string, never>;
    const threadId = (notif["properties"] as Record<string, Record<string, unknown>>)["threadId"];
    expect(threadId["type"]).toEqual(["string", "null"]);
  });

  it.skipIf(!codexAvailable())(
    "installed codex-cli still emits the pinned MCP schema",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "appserver-schema-"));
      try {
        execFileSync("codex", ["app-server", "generate-json-schema", "--out", dir], {
          encoding: "utf8",
          timeout: 120_000,
        });
        const live = JSON.parse(
          readFileSync(join(dir, "codex_app_server_protocol.v2.schemas.json"), "utf8"),
        ) as { definitions?: Record<string, unknown> };

        const defs = live.definitions ?? {};
        for (const name of TRACKED) {
          expect(
            defs[name],
            `${name} vanished from the installed codex-cli schema; the protocol moved`,
          ).toBeTruthy();
          expect(
            defs[name],
            `${name} changed shape in the installed codex-cli; re-run the Phase 1 capture ` +
              `in PLAN_MCP_BOOT_INTROSPECTION.md before trusting mcpStatus, then update this fixture`,
          ).toEqual(fixture[name]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    150_000,
  );
});
