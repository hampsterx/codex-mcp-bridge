/**
 * Read and parse the user's Codex CLI config (`$CODEX_HOME/config.toml` or
 * `~/.codex/config.toml`), plus any project `.codex/config.toml` above the
 * spawn's working directory, to enumerate configured MCP servers.
 *
 * Used by `getMcpServerOverride()` to emit per-server
 * `-c mcp_servers.NAME.enabled=false` disables. A blanket `-c mcp_servers={}`
 * override silently no-ops due to config-merge semantics (upstream #16045,
 * still true on Codex 0.163.0), so enumeration is the only reliable path.
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  /**
   * Set only for a server declared in a project `.codex/config.toml` and not
   * in the user config. See `listProjectMcpServers()` for why it is carried.
   */
  projectTransport?: McpTransport;
}

/**
 * The transport field Codex requires on every MCP server table: `command`
 * for stdio, `url` for streamable HTTP. An entry with neither is rejected
 * with "invalid transport", and one carrying the other kind's field with
 * "url is not supported for stdio".
 */
export interface McpTransport {
  key: "command" | "url";
  value: string;
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
 * Collect literal credential values declared under `[mcp_servers.NAME.env]`.
 *
 * Codex injects these straight into the MCP server process, so they never
 * appear in the bridge's own `process.env` and value-based redaction cannot
 * see them without reading them here. A server that echoes its own token into
 * a startup failure would otherwise leak it verbatim whenever that token has
 * no recognisable prefix for pattern matching to catch.
 *
 * Returns every value in those tables rather than only secret-looking keys:
 * the caller applies a length floor, and over-redacting a stray non-secret
 * inside an error string is cheap next to leaking a credential.
 */
export function listMcpServerEnvValues(config: CodexConfig | null): string[] {
  if (
    !config ||
    !config.mcp_servers ||
    typeof config.mcp_servers !== "object" ||
    Array.isArray(config.mcp_servers)
  ) {
    return [];
  }

  const values: string[] = [];
  for (const entry of Object.values(config.mcp_servers)) {
    if (typeof entry !== "object" || entry === null) continue;
    const env = (entry as Record<string, unknown>)["env"];
    if (typeof env !== "object" || env === null || Array.isArray(env)) continue;
    for (const value of Object.values(env as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) values.push(value);
    }
  }
  return values;
}

/**
 * Return MCP servers declared in project `.codex/config.toml` files that
 * Codex may load for a spawn in `cwd`.
 *
 * Codex loads `.codex/config.toml` from each directory between `cwd` and the
 * project root, but only when the project is trusted, and trust is keyed on
 * the directory, the project root and the repository root. Rather than
 * reproduce those rules this scans every directory from `cwd` up to the
 * filesystem root, which is a superset of what any trust decision loads.
 *
 * Over-enumeration is only safe because each server keeps its declared
 * transport. A bare `-c mcp_servers.NAME.enabled=false` for a server Codex
 * did not load (an untrusted project) creates a table with no transport and
 * Codex refuses to start. Re-stating the server's own `command` or `url`
 * alongside `enabled=false` keeps the table valid either way, and a disabled
 * server never spawns, so this cannot run anything Codex's trust gate kept off.
 *
 * Unreadable or unparseable files, and entries with no string `command` or
 * `url`, are skipped: Codex reports its own error if it loads them. So is a
 * server whose name is not a TOML bare key, with a warning: Codex's `-c`
 * parser splits the key path on `.` and the argument on the first `=` with no
 * unquoting, so `quoteKey`'s quoting reaches it as literal characters and a
 * name like `my.server` would create a transport-less table that stops every
 * call from starting, trusted project or not. Where
 * several files declare one name, the one nearest `cwd` supplies the
 * transport (Codex merges nearer layers on top) and `required` is true if
 * any of them says so.
 *
 * @param cwd             Working directory the Codex subprocess will run in.
 * @param userConfigPath  The user config, skipped if the walk reaches it.
 */
export function listProjectMcpServers(
  cwd: string,
  userConfigPath: string = resolveCodexConfigPath(),
): ConfiguredServer[] {
  const userConfig = canonical(userConfigPath);
  const seenFiles = new Set<string>();
  const byName = new Map<string, ConfiguredServer>();

  for (const start of new Set([resolve(cwd), canonical(cwd)])) {
    for (let dir = start; ; dir = dirname(dir)) {
      const file = canonical(join(dir, ".codex", "config.toml"));
      if (file !== userConfig && !seenFiles.has(file)) {
        seenFiles.add(file);
        for (const server of readProjectServers(file)) {
          const prior = byName.get(server.name);
          if (prior) prior.required ||= server.required;
          else byName.set(server.name, server);
        }
      }
      if (dirname(dir) === dir) break;
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fold project-declared servers into the user config's list. A name the user
 * config already declares keeps the user entry unchanged, `required` included:
 * the project file may be one Codex never loaded, and an untrusted repository
 * must not be able to keep one of the user's servers running.
 */
export function mergeProjectServers(
  user: ConfiguredServer[],
  project: ConfiguredServer[],
): ConfiguredServer[] {
  const byName = new Map(user.map((s) => [s.name, s]));
  for (const server of project) {
    if (!byName.has(server.name)) byName.set(server.name, server);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `realpath` when the path exists, else the path as resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Servers with a usable transport from one project config file, or none. */
function readProjectServers(file: string): ConfiguredServer[] {
  let config: CodexConfig;
  try {
    config = parseToml(readFileSync(file, "utf8")) as CodexConfig;
  } catch {
    return [];
  }
  const servers = config.mcp_servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return [];
  }

  const result: ConfiguredServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!BARE_KEY.test(name)) {
      console.warn(
        `codex-mcp-bridge: not disabling MCP server '${name}' from ${file}: ` +
        `only names matching [A-Za-z0-9_-] can be addressed by a Codex -c override`,
      );
      continue;
    }
    const table = entry as Record<string, unknown>;
    let projectTransport: McpTransport;
    if (typeof table["command"] === "string") {
      projectTransport = { key: "command", value: table["command"] };
    } else if (typeof table["url"] === "string") {
      projectTransport = { key: "url", value: table["url"] };
    } else {
      continue;
    }
    result.push({ name, required: table["required"] === true, projectTransport });
  }
  return result;
}

/**
 * Encode a string as a TOML basic string, for a `-c key=value` value.
 */
export function tomlString(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
    switch (ch) {
      case "\\": return "\\\\";
      case '"': return '\\"';
      case "\b": return "\\b";
      case "\t": return "\\t";
      case "\n": return "\\n";
      case "\f": return "\\f";
      case "\r": return "\\r";
      default: return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
  return `"${escaped}"`;
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
 *   - A project-only server (`projectTransport` set) is disabled with its
 *     transport re-stated, so the override is valid whether or not Codex
 *     trusted the project. In the `enabled` set it gets no override at all:
 *     `enabled=true` alone breaks startup when the project is untrusted, and
 *     with a transport it would start a server Codex's trust gate kept off.
 *     It runs only if Codex loaded it and its own config leaves it enabled.
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
  for (const { name, required, projectTransport } of sorted) {
    const key = `mcp_servers.${quoteKey(name)}`;
    if (enabled?.has(name)) {
      if (!projectTransport) out.push("-c", `${key}.enabled=true`);
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
    out.push("-c", `${key}.enabled=false`);
    if (projectTransport) {
      out.push("-c", `${key}.${projectTransport.key}=${tomlString(projectTransport.value)}`);
    }
  }
  return out;
}

