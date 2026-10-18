import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpServerOverride } from "../../src/utils/env.js";

const runIntegration = process.env["CODEX_INTEGRATION"] === "1";
const maybeIt = runIntegration ? it : it.skip;

interface ListedServer {
  name: string;
  enabled: boolean;
  transport?: { command?: string; args?: string[] };
}

/**
 * The unit tests assert the argv the bridge emits; these assert what Codex
 * makes of it, by reading back its parsed config with `codex mcp list --json`
 * (which loads the same user and project layers as `exec` without starting
 * any server). That is the only way to check the security property: names
 * from an untrusted repository cannot reshape the `mcp_servers` table.
 */
describe("MCP suppression as Codex parses it", () => {
  let root: string;
  let home: string;
  let project: string;
  const origHome = process.env["CODEX_HOME"];
  const origMcp = process.env["CODEX_MCP_SERVERS"];

  const adversarial = ["a.b", "a=b", 'q"x', "pwn={command='/bin/true',enabled=true}#", "ünï"];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codex-mcp-suppression-")));
    home = path.join(root, "home");
    project = path.join(root, "proj");
    mkdirSync(home);
    mkdirSync(path.join(project, ".codex"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: project });

    writeFileSync(
      path.join(home, "config.toml"),
      [
        '[mcp_servers.keep]\ncommand = "/bin/false"\nargs = ["keep-arg"]\nenabled = false',
        '[mcp_servers.drop]\ncommand = "/bin/false"',
        '[mcp_servers.req]\ncommand = "/bin/false"\nrequired = true',
      ].join("\n\n"),
    );
    writeFileSync(
      path.join(project, ".codex", "config.toml"),
      adversarial
        .map((name) => `[mcp_servers.${JSON.stringify(name)}]\ncommand = "/bin/false"`)
        .join("\n\n"),
    );

    process.env["CODEX_HOME"] = home;
    process.env["CODEX_MCP_SERVERS"] = "keep";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (origHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origHome;
    if (origMcp === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcp;
  });

  /** `codex mcp list --json` under the temp home; throws if Codex rejects the config. */
  function listServers(): Map<string, ListedServer> {
    const args = ["mcp", "list", "--json", ...getMcpServerOverride(undefined, { cwd: project })];
    const out = execFileSync("codex", args, {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: home },
      timeout: 60_000,
    });
    return new Map((JSON.parse(out) as ListedServer[]).map((s) => [s.name, s]));
  }

  function expectSuppressed(servers: Map<string, ListedServer>): void {
    // Enabled on request, keeping its own transport: the table merged.
    expect(servers.get("keep")?.enabled).toBe(true);
    expect(servers.get("keep")?.transport?.args).toEqual(["keep-arg"]);
    expect(servers.get("drop")?.enabled).toBe(false);
    expect(servers.get("req")?.enabled).toBe(true);
    for (const name of adversarial) {
      expect(servers.get(name)?.enabled, name).toBe(false);
    }
    // Nothing named after a fragment of a split key path.
    const expected = new Set(["keep", "drop", "req", ...adversarial]);
    expect([...servers.keys()].filter((n) => !expected.has(n))).toEqual([]);
  }

  maybeIt("disables every project server, whatever its name, in a trusted project", () => {
    writeFileSync(
      path.join(home, "config.toml"),
      `\n\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
      { flag: "a" },
    );
    expectSuppressed(listServers());
  });

  maybeIt("keeps the config loadable from an untrusted project", () => {
    expectSuppressed(listServers());
  });
});
