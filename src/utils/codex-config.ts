/**
 * Read and parse the user's Codex CLI config (`$CODEX_HOME/config.toml` or
 * `~/.codex/config.toml`), plus any project `.codex/config.toml` above the
 * spawn's working directory, to enumerate configured MCP servers.
 *
 * Used by `getMcpServerOverride()` to emit one `-c mcp_servers={...}` table
 * naming each server to disable. An empty `-c mcp_servers={}` silently
 * no-ops due to config-merge semantics (upstream #16045, still true on Codex
 * 0.163.0), so enumeration is the only reliable path.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
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
 * project root (see `findProjectRoot`), but only when the project is trusted,
 * and trust is keyed on the directory, the project root and the repository
 * root. This reads the same directories and does not reproduce the trust
 * rules, so it is a superset of what any trust decision loads. It stops at
 * the root, as Codex does: a file above it (say a world-writable
 * `/tmp/.codex/config.toml` over a checkout in `/tmp`) is never loaded by
 * Codex and must not mark a project server `required` here.
 *
 * The walk starts from `realpath(cwd)`: Codex reads its working directory
 * with `getcwd`, which is the physical path, and the bridge passes no `PWD`.
 *
 * Over-enumeration is only safe because each server keeps its declared
 * transport. Disabling a server Codex did not load (an untrusted project)
 * without one creates a table with no transport and Codex refuses to start.
 * Re-stating the server's own `command` or `url` alongside `enabled=false`
 * keeps the table valid either way, and a disabled server never spawns, so
 * this cannot run anything Codex's trust gate kept off.
 *
 * Declarations are merged per key, nearest file first, as Codex merges nearer
 * layers on top, so a nearer file that only sets `required = true` on a server
 * a farther one declares still counts. The transport is taken from the
 * nearest file declaring a string `command` or `url`, and a server with
 * neither after the merge is skipped: Codex rejects it if it loads it.
 * Files are read through `readProjectConfigText`, which bounds what an
 * untrusted repository can make the bridge read.
 *
 * @param cwd             Working directory the Codex subprocess will run in.
 * @param userConfigPath  The user config, skipped if the walk reaches it.
 * @param markers         Project root markers, from `projectRootMarkers()`.
 */
export function listProjectMcpServers(
  cwd: string,
  userConfigPath: string = resolveCodexConfigPath(),
  markers: readonly string[] = DEFAULT_PROJECT_ROOT_MARKERS,
): ConfiguredServer[] {
  const userConfig = canonical(userConfigPath);
  const byName = new Map<string, { transport?: McpTransport; required?: boolean }>();

  const start = canonical(cwd);
  const root = findProjectRoot(start, markers) ?? start;
  for (let dir = start; ; dir = dirname(dir)) {
    const file = canonical(join(dir, ".codex", "config.toml"));
    if (file !== userConfig) {
      for (const [name, table] of readProjectServerTables(file)) {
        const merged = byName.get(name) ?? {};
        if (merged.transport === undefined) merged.transport = transportOf(table);
        if (merged.required === undefined && typeof table["required"] === "boolean") {
          merged.required = table["required"];
        }
        byName.set(name, merged);
      }
    }
    if (dir === root || dirname(dir) === dir) break;
  }

  const result: ConfiguredServer[] = [];
  for (const [name, { transport, required }] of byName) {
    if (transport) result.push({ name, required: required === true, projectTransport: transport });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
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

/** Codex's default `project_root_markers`. */
const DEFAULT_PROJECT_ROOT_MARKERS: readonly string[] = [".git"];

/**
 * The project root markers Codex will use: `project_root_markers` from the
 * user config when it is an array of strings (an empty array disables root
 * detection), else `[".git"]`. Any other type makes Codex refuse to load the
 * config, so the default is as good as anything there.
 */
export function projectRootMarkers(config: CodexConfig | null): readonly string[] {
  const markers = config?.["project_root_markers"];
  if (Array.isArray(markers) && markers.every((m) => typeof m === "string")) {
    return markers as string[];
  }
  return DEFAULT_PROJECT_ROOT_MARKERS;
}

/**
 * The nearest ancestor of `start` (itself included) holding any marker, as
 * Codex's `discover_project_root` finds it, or `undefined` when none does, in
 * which case Codex treats `start` as the root. A marker counts when it exists
 * in any form, so a linked worktree's `.git` file counts; a `.git` directory
 * counts only when it has a `HEAD`.
 */
export function findProjectRoot(start: string, markers: readonly string[]): string | undefined {
  if (markers.length === 0) return undefined;
  for (let dir = start; ; dir = dirname(dir)) {
    for (const marker of markers) {
      const path = join(dir, marker);
      if (!pathExists(path)) continue;
      if (marker === ".git" && isDirectory(path) && !pathExists(join(path, "HEAD"))) continue;
      return dir;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Whether `path` exists, following symlinks, as Codex's metadata lookup does. */
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `realpath` when the path exists, else the path as resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Largest project config the bridge will read. Real ones are a few KB. */
export const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;

/**
 * Read a project config without letting the repository stall or exhaust the
 * bridge, which reads it synchronously before any subprocess timeout runs.
 *
 * Only regular files up to `MAX_PROJECT_CONFIG_BYTES` are read; a FIFO, a
 * device such as `/dev/zero` or an oversized file yields `null`. A symlink is
 * followed, because Codex follows it too and refusing it would leave a server
 * Codex loads unsuppressed; the checks apply to its target. The type is
 * checked before opening (so a FIFO is never opened for a blocking read) and
 * again on the open descriptor, which is opened non-blocking, so swapping the
 * path between the two cannot get a special file read either.
 */
export function readProjectConfigText(file: string): string | null {
  let fd: number;
  try {
    if (!statSync(file).isFile()) return null;
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0));
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PROJECT_CONFIG_BYTES) return null;
    // One byte of headroom shows a file that grew past its stat size.
    const buf = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buf, length, buf.length - length, null);
      if (read === 0) break;
      length += read;
      if (length === buf.length) return null;
    }
    return buf.toString("utf8", 0, length);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The `[mcp_servers.*]` tables of one project config file, or none. */
function readProjectServerTables(file: string): Array<[string, Record<string, unknown>]> {
  const text = readProjectConfigText(file);
  if (text === null) return [];
  let config: CodexConfig;
  try {
    config = parseToml(text) as CodexConfig;
  } catch {
    return [];
  }
  const servers = config.mcp_servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return [];
  }
  return Object.entries(servers).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]),
  );
}

/** The transport a server table declares, `command` first, if any. */
function transportOf(table: Record<string, unknown>): McpTransport | undefined {
  if (typeof table["command"] === "string") return { key: "command", value: table["command"] };
  if (typeof table["url"] === "string") return { key: "url", value: table["url"] };
  return undefined;
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
 * Quote a TOML key for use inside the `mcp_servers` inline table that
 * `buildMcpArgs` emits, matching TOML's basic-string quoting rules.
 *
 * Only valid on the value side of `-c`. Codex's `-c` parser splits the
 * argument on the first `=` and the key path on `.` with no unquoting, so a
 * quoted key in the path arrives as literal characters.
 */
export function quoteKey(name: string): string {
  return BARE_KEY.test(name) ? name : tomlString(name);
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
 * Build CLI args to control configured MCP servers, as one
 * `-c mcp_servers={...}` inline table (or none when there is nothing to say).
 *
 * Server names go inside the value, which Codex parses as real TOML, never in
 * the `-c` key path, which it splits on `.` and `=` without unquoting: there a
 * project server named `a.b` broke every call and one named
 * `x={command='...',enabled=true}#` injected an enabled server. A non-empty
 * table value merges into the loaded user and project tables rather than
 * replacing them (measured on codex-cli 0.163.0: a server enabled here keeps
 * its own `command` and `args`); only the empty `{}` no-ops (upstream #16045).
 *
 *   - Servers in the `enabled` set get `NAME={enabled=true}`, so a requested
 *     server that happens to be `enabled = false` in `config.toml` is still
 *     turned on. Without this, the bridge's only lever is the disable path
 *     and a user who asked `CODEX_MCP_SERVERS=serena` on a config where
 *     `serena.enabled = false` would end up with serena silently off.
 *   - Every other configured server gets `NAME={enabled=false}`, except
 *     `required = true` servers which are always kept enabled (disabling them
 *     would break Codex startup).
 *   - A project-only server (`projectTransport` set) is disabled with its
 *     transport re-stated, so the entry is valid whether or not Codex trusted
 *     the project. In the `enabled` set it gets no entry at all:
 *     `enabled=true` alone breaks startup when the project is untrusted, and
 *     with a transport it would start a server Codex's trust gate kept off.
 *     It runs only if Codex loaded it and its own config leaves it enabled.
 *
 * `enabled` is the set of server names the caller wants left on.
 *   - `undefined` → disable all non-required (default "disable-all" behaviour).
 *     No `enabled=true` entries are emitted: anyone relying on the default
 *     already has their config pointed the way they want.
 *   - `new Set()` → same as undefined (no servers enabled, disable all non-required).
 *   - `new Set(["serena"])` → `serena={enabled=true}`; disable every other
 *     non-required server.
 *
 * When a required server is not in the enable set and `enabled` was explicitly
 * provided, emits one warning per offending name (the caller's list would have
 * dropped it). Pass `silent: true` to suppress that warning for implicit tool
 * defaults. The default disable-all path (`enabled === undefined`) stays
 * silent regardless.
 *
 * Entries are sorted by server name for stable output.
 */
export function buildMcpArgs(
  configured: ConfiguredServer[],
  enabled?: ReadonlySet<string>,
  { silent = false }: BuildMcpArgsOptions = {},
): string[] {
  const entries: string[] = [];
  const sorted = [...configured].sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, required, projectTransport } of sorted) {
    const key = quoteKey(name);
    if (enabled?.has(name)) {
      if (!projectTransport) entries.push(`${key}={enabled=true}`);
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
    const transport = projectTransport
      ? `, ${projectTransport.key}=${tomlString(projectTransport.value)}`
      : "";
    entries.push(`${key}={enabled=false${transport}}`);
  }
  return entries.length > 0 ? ["-c", `mcp_servers={${entries.join(", ")}}`] : [];
}
