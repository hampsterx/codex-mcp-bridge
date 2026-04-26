/**
 * Read and parse the user's Codex CLI config (`$CODEX_HOME/config.toml` or
 * `~/.codex/config.toml`) to enumerate configured MCP servers.
 *
 * Used by `getMcpServerOverride()` to emit per-server
 * `-c mcp_servers.NAME.enabled=false` disables. A blanket `-c mcp_servers={}`
 * override silently no-ops on Codex 0.115.0 due to config-merge semantics
 * (upstream #16045), so enumeration is the only reliable path.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export interface CodexConfig {
  mcp_servers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * One configured MCP server, with the subset of metadata the bridge cares about.
 * `required` comes from codex PR #10902 and maps to `required = true` under the
 * server's TOML table. When true the bridge refuses to disable the server even
 * if the caller's `CODEX_MCP_SERVERS` list would otherwise drop it.
 */
export interface ConfiguredServer {
  name: string;
  required: boolean;
}

/**
 * Resolve the path to the user's Codex config.toml.
 * Honors `CODEX_HOME`; falls back to `~/.codex`.
 */
export function resolveCodexConfigPath(): string {
  const home = process.env["CODEX_HOME"] || join(homedir(), ".codex");
  return join(home, "config.toml");
}

/**
 * Read and parse the Codex config.toml. Returns `null` if the file does not
 * exist. Throws a descriptive error on I/O or parse failure, pointing at the
 * `CODEX_MCP_SERVERS=inherit` escape hatch so users can unblock themselves.
 */
export function readCodexConfig(path: string = resolveCodexConfigPath()): CodexConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(
      `codex-mcp-bridge: failed to read ${path}: ${(err as Error).message}. ` +
      `Set CODEX_MCP_SERVERS=inherit to bypass MCP server control.`,
    );
  }

  try {
    return parseToml(raw) as CodexConfig;
  } catch (err) {
    throw new Error(
      `codex-mcp-bridge: failed to parse ${path}: ${(err as Error).message}. ` +
      `Set CODEX_MCP_SERVERS=inherit to bypass MCP server control.`,
    );
  }
}

/**
 * Return all MCP server names declared in the config (stdio or URL-based).
 * Order: lexicographic for stable output.
 */
export function listMcpServerNames(config: CodexConfig | null): string[] {
  if (
    !config ||
    !config.mcp_servers ||
    typeof config.mcp_servers !== "object" ||
    Array.isArray(config.mcp_servers)
  ) {
    return [];
  }
  return Object.keys(config.mcp_servers).sort();
}

/**
 * Return each configured MCP server with its `required` flag.
 *
 * Source: the user's `~/.codex/config.toml` (already parsed). We read the
 * `required` field directly from TOML rather than spawning `codex mcp list
 * --json` so this stays synchronous and adds no per-spawn subprocess cost.
 * See PLAN_MCP_INTROSPECTION_1.md Decision Log for the rationale.
 *
 * Order: lexicographic for stable output.
 */
export function listMcpServers(config: CodexConfig | null): ConfiguredServer[] {
  if (
    !config ||
    !config.mcp_servers ||
    typeof config.mcp_servers !== "object" ||
    Array.isArray(config.mcp_servers)
  ) {
    return [];
  }
  const result: ConfiguredServer[] = [];
  for (const [name, entry] of Object.entries(config.mcp_servers)) {
    const required =
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>)["required"] === true;
    result.push({ name, required });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * TOML bare keys allow `[A-Za-z0-9_-]`. Anything else must be quoted.
 */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Quote a TOML key for use in a `-c mcp_servers.NAME.enabled=false` path,
 * matching TOML's basic-string quoting rules.
 */
export function quoteKey(name: string): string {
  if (BARE_KEY.test(name)) return name;
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface BuildMcpArgsOptions {
  /**
   * Suppress the "refusing to disable required MCP server" warning. Set when
   * the enable list came from an implicit tool default (e.g. `query.ts`
   * passing `""` to disable all servers), not from explicit caller input.
   * Keeps the console quiet for users who never asked for a specific list.
   */
  silent?: boolean;
}

/**
 * Build CLI args to control configured MCP servers:
 *
 *   - Servers in the `enabled` set get an explicit
 *     `-c mcp_servers.NAME.enabled=true` override, so a requested server that
 *     happens to be `enabled = false` in `config.toml` is still turned on.
 *     Without this, the bridge's only lever is the disable path and a user
 *     who asked `CODEX_MCP_SERVERS=serena` on a config where `serena.enabled
 *     = false` would end up with serena silently off.
 *   - Every other configured server gets `-c mcp_servers.NAME.enabled=false`,
 *     except `required = true` servers which are always kept enabled
 *     (disabling them would break Codex startup).
 *
 * `enabled` is the set of server names the caller wants left on.
 *   - `undefined` → disable all non-required (default "disable-all" behaviour).
 *     No `enabled=true` overrides are emitted: anyone relying on the default
 *     already has their config pointed the way they want.
 *   - `new Set()` → same as undefined (no servers enabled, disable all non-required).
 *   - `new Set(["serena"])` → emit `serena.enabled=true`; disable every other
 *     non-required server.
 *
 * When a required server is not in the enable set and `enabled` was explicitly
 * provided, emits one warning per offending name (the caller's list would have
 * dropped it). Pass `silent: true` to suppress that warning for implicit tool
 * defaults. The default disable-all path (`enabled === undefined`) stays
 * silent regardless.
 *
 * Args are sorted by server name for stable output.
 */
export function buildMcpArgs(
  configured: ConfiguredServer[],
  enabled?: ReadonlySet<string>,
  { silent = false }: BuildMcpArgsOptions = {},
): string[] {
  const out: string[] = [];
  const sorted = [...configured].sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, required } of sorted) {
    if (enabled?.has(name)) {
      out.push("-c", `mcp_servers.${quoteKey(name)}.enabled=true`);
      continue;
    }
    if (required) {
      if (enabled !== undefined && !silent) {
        console.warn(
          `codex-mcp-bridge: refusing to disable required MCP server '${name}' (required=true); keeping it enabled`,
        );
      }
      continue;
    }
    out.push("-c", `mcp_servers.${quoteKey(name)}.enabled=false`);
  }
  return out;
}

