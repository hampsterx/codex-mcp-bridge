/**
 * Hardened subprocess environment builder.
 * Never spreads process.env — uses an explicit allowlist.
 *
 * Per plan review: explicit keys only, not wildcard OPENAI_* (too broad,
 * risks leaking unintended config).
 */

import {
  readCodexConfig,
  readNonProjectLayers,
  listNonProjectMcpServers,
  markersFromLayers,
  listProjectMcpServers,
  mergeProjectServers,
  resolveCodexConfigPath,
  resolveSystemConfigPaths,
  managedEnabledFlags,
  buildMcpArgs,
  type CodexSystemConfigPaths,
  type ConfiguredServer,
} from "./codex-config.js";

const ALLOWED_ENV_KEYS = [
  // OpenAI / Codex auth
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  // Codex config
  "CODEX_HOME",
  "CODEX_DEFAULT_MODEL",
  // System essentials
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
];

/**
 * Build CLI args to control Codex's internal MCP servers.
 *
 * When running as a bridge, Codex's own MCP servers (playwright, serena,
 * github, etc.) add 30-120s startup overhead per spawn with no benefit,
 * since the bridge feeds context via prompt + files, not MCP tools.
 *
 * Grammar for the source value (`override` arg if provided, else
 * `CODEX_MCP_SERVERS` env var). Branches are evaluated in this order:
 *
 *   1. unset / empty / whitespace-only → disable every configured server
 *      except those marked `required=true` (default, fastest). Enumerates
 *      each server into one `-c mcp_servers={NAME={enabled=false}, ...}`
 *      table (see `buildMcpArgs`). An empty `mcp_servers={}` override
 *      silently no-ops due to config-merge semantics (upstream #16045,
 *      still true on Codex 0.163.0), so enumeration is the only reliable
 *      path. "Configured" covers the user
 *      config and, when `cwd` is given, project `.codex/config.toml` files
 *      above it (see `listProjectMcpServers`).
 *
 *      Truly unset (no `override`, no env var) stays silent about required
 *      servers being kept on. An **explicit** empty/whitespace value —
 *      caller passed `""` or set `CODEX_MCP_SERVERS=""` — is treated as
 *      "I want disable-all" and warns loudly if the request would drop a
 *      required server (via `buildMcpArgs` with an empty enable set).
 *      This keeps the noisy default path quiet while still honouring the
 *      README contract that required-server drops get surfaced.
 *   2. `"inherit"` (exact, case-sensitive, after trim) → pass through
 *      whatever's in ~/.codex/config.toml unchanged.
 *   3. first non-whitespace char is `{` or `[` → raw TOML escape hatch,
 *      passed through as `-c mcp_servers=VALUE`. (Narrowing of the older
 *      "any non-empty non-inherit value is raw TOML" behaviour — the env
 *      var is unreleased so this break is acceptable.)
 *   4. otherwise → comma-separated list of server names to ENABLE. Every
 *      other configured server is disabled (except required ones). Empty
 *      items filtered, whitespace trimmed, duplicates deduped, unknowns
 *      warned to stderr and ignored.
 *
 * Synchronous by contract: called from multiple hot paths inside arg-spread
 * expressions in the tool modules. The config file is small (~3KB) and
 * re-read on every spawn so new servers are picked up without cache logic.
 *
 * @param override  Explicit value to use instead of `CODEX_MCP_SERVERS`.
 *                  Tool modules pass this to set their own defaults (e.g.
 *                  `query.ts` passes `""` to disable all servers for the
 *                  isolated query path).
 * @param options.silent  Suppress "unknown server" and "refusing to disable
 *                  required" warnings. Set by callers passing an implicit
 *                  tool default so users who never asked for a list don't
 *                  get yelled at for the bridge's internal preferences.
 * @param options.cwd  Working directory the subprocess will spawn in. Every
 *                  spawning tool passes it; without it, servers declared in a
 *                  trusted project's `.codex/config.toml` boot unsuppressed.
 * @param options.systemConfigPaths  System and managed config files to read
 *                  (see `readNonProjectLayers`). Omitted means Codex's real
 *                  `/etc/codex` paths (none on Windows); `null` reads neither.
 *                  Tools never pass it; it exists so tests stay off the host.
 */
export function getMcpServerOverride(
  override?: string,
  {
    silent = false,
    cwd,
    systemConfigPaths,
  }: { silent?: boolean; cwd?: string; systemConfigPaths?: CodexSystemConfigPaths | null } = {},
): string[] {
  const envValue = process.env["CODEX_MCP_SERVERS"];
  // "Explicit" means the caller or the env var provided a value (even if it's
  // an empty string or whitespace). Truly-unset = both undefined.
  const explicit = override !== undefined || envValue !== undefined;
  const raw = override !== undefined ? override : envValue;
  const val = raw?.trim() ?? "";

  const scope: ServerScope = { cwd, systemConfigPaths };
  if (val === "") return disableNonRequiredServers(explicit, silent, scope);
  if (val === "inherit") return [];
  if (val[0] === "{" || val[0] === "[") return rawTomlOverride(val);
  return enableListedServers(val, silent, scope);
}

/** Where `configuredServers` looks: the spawn cwd and the system config paths. */
interface ServerScope {
  cwd: string | undefined;
  systemConfigPaths: CodexSystemConfigPaths | null | undefined;
}

/** System, user and managed config servers, plus project-declared ones when `cwd` is known. */
function configuredServers({ cwd, systemConfigPaths }: ServerScope): ConfiguredServers {
  const paths = resolveSystemConfigPaths(systemConfigPaths);
  const layers = readNonProjectLayers(readCodexConfig(), paths);
  const managed = paths
    ? { file: paths.managed, enabled: managedEnabledFlags(layers[layers.length - 1] ?? null) }
    : { file: "", enabled: new Map<string, boolean>() };
  const own = listNonProjectMcpServers(layers);
  if (cwd === undefined) return { servers: own, managed };
  const project = listProjectMcpServers(
    cwd,
    resolveCodexConfigPath(),
    markersFromLayers(layers),
    new Set(own.map((s) => s.name)),
  );
  return { servers: mergeProjectServers(own, project), managed };
}

/** Configured servers, plus the managed config's `enabled` values, which outrank `-c`. */
interface ConfiguredServers {
  servers: ConfiguredServer[];
  managed: { file: string; enabled: ReadonlyMap<string, boolean> };
}

/**
 * Warn when the managed config will overrule the override `buildMcpArgs`
 * emits. Codex merges managed config above `-c` overrides: it is admin policy,
 * so the bridge neither fights it nor refuses the call, and the argv is the
 * same either way. One warning per direction per spawn, naming every server:
 * servers the bridge disables that managed config keeps enabled, and servers
 * the caller asked to enable that managed config keeps disabled.
 */
function warnManagedOverrides(
  { servers, managed }: ConfiguredServers,
  enabled: ReadonlySet<string> | undefined,
  silent: boolean,
): void {
  if (silent || managed.enabled.size === 0) return;
  const keptOn: string[] = [];
  const keptOff: string[] = [];
  for (const { name, required, projectTransport } of servers) {
    const policy = managed.enabled.get(name);
    if (enabled?.has(name)) {
      if (!projectTransport && policy === false) keptOff.push(name);
    } else if (!required && policy === true) {
      keptOn.push(name);
    }
  }
  const list = (names: string[]): string => names.map((n) => `'${n}'`).join(", ");
  if (keptOn.length > 0) {
    console.warn(
      `codex-mcp-bridge: managed config ${managed.file} keeps MCP server(s) ${list(keptOn)} enabled; ` +
      `it outranks the bridge's -c overrides, so they will start despite being disabled here`,
    );
  }
  if (keptOff.length > 0) {
    console.warn(
      `codex-mcp-bridge: managed config ${managed.file} keeps MCP server(s) ${list(keptOff)} disabled; ` +
      `it outranks the bridge's -c overrides, so the request to enable them has no effect`,
    );
  }
}

/**
 * Disable all non-required MCP servers.
 * When `explicit` is true and `silent` is false, warnings are emitted
 * for required servers that cannot be disabled.
 */
function disableNonRequiredServers(
  explicit: boolean,
  silent: boolean,
  scope: ServerScope,
): string[] {
  const configured = configuredServers(scope);
  warnManagedOverrides(configured, undefined, silent);
  if (explicit && !silent) {
    return buildMcpArgs(configured.servers, new Set<string>());
  }
  return buildMcpArgs(configured.servers);
}

/** Pass raw TOML through as a `-c` flag. */
function rawTomlOverride(val: string): string[] {
  return ["-c", `mcp_servers=${val}`];
}

/**
 * Parse a comma-separated list of server names to enable.
 * Unknown names are warned (unless silent) and dropped.
 */
function enableListedServers(val: string, silent: boolean, scope: ServerScope): string[] {
  const requested = val
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const configured = configuredServers(scope);
  const configuredNames = new Set(configured.servers.map((s) => s.name));

  const enabled = new Set<string>();
  const warnedUnknowns = new Set<string>();
  for (const name of requested) {
    if (configuredNames.has(name)) {
      enabled.add(name);
    } else if (!silent && !warnedUnknowns.has(name)) {
      warnedUnknowns.add(name);
      console.warn(
        `codex-mcp-bridge: ignoring unknown MCP server '${name}' in CODEX_MCP_SERVERS`,
      );
    }
  }

  warnManagedOverrides(configured, enabled, silent);
  return buildMcpArgs(configured.servers, enabled, { silent });
}

/**
 * Pin the approvals reviewer to `user`, so the sandbox level we ask for binds.
 *
 * `approvals_reviewer` decides who approves a sandbox escalation request. Its
 * other value, `auto_review`, hands that decision to a model instead of a
 * human: "Sandbox escalations with require_escalated will be reviewed for
 * compliance with the policy". Under `codex exec` there is no human in the
 * loop, so a user config carrying `auto_review` lets the subprocess escalate
 * straight out of the level we passed, unsupervised and unreported. A caller
 * asking for `read-only` then gets a turn that writes files, with `--sandbox
 * read-only` sitting in the argv the whole time.
 *
 * Emitting `-c approvals_reviewer="user"` restores the refusal: with no human
 * to ask, the escalation is denied and the sandbox holds. This pins only the
 * bridge's own subprocess and leaves the user's interactive Codex alone, which
 * is why it is preferred over `--ignore-user-config` (the `review` tool passes
 * that, but it can afford to; the other tools need user config for model and
 * auth resolution).
 *
 * Spread into argv alongside `getMcpServerOverride()`, and for the same reason:
 * an explicit flag is worth nothing if config can quietly overrule it.
 */
export function getApprovalsReviewerOverride(): string[] {
  return ["-c", 'approvals_reviewer="user"'];
}

/**
 * Environment for the MCP boot-introspection app-server session.
 *
 * Deliberately inherits the full environment instead of the
 * `ALLOWED_ENV_KEYS` allowlist that `buildSubprocessEnv()` applies. This is
 * the same reasoning that makes introspection skip `getMcpServerOverride()`:
 * hardening the child disables the thing being measured.
 *
 * Concretely, MCP servers read their credentials from the environment
 * (`bearer_token_env_var`, `mcp_servers.NAME.env`). Under the allowlist those
 * variables vanish and the server fails to start, so the tool reports a
 * fabricated failure ("Environment variable X is not set") for a server that
 * is perfectly healthy in the user's own Codex. A boot report that invents
 * failures is worse than no report, because it sends someone chasing a
 * problem that does not exist.
 *
 * Why this is acceptable here, where it would not be for the other tools:
 *
 *  - Neither introspection sequence submits a turn, so no environment value
 *    is ever sent to a model. The allowlist exists to keep secrets out of
 *    model context, and there is no model in this path.
 *  - The child MCP servers receive exactly the environment they would get
 *    from the user running `codex` themselves. That is the measurement.
 *  - The only text leaving this path is the startup error string, which is
 *    redacted before it reaches the caller.
 */
export function buildIntrospectionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Pinned AFTER the copy. Seeding them first lets an inherited FORCE_COLOR=1
  // win, which puts ANSI escapes into the JSONL stream the parser reads.
  env["NO_COLOR"] = "1";
  env["FORCE_COLOR"] = "0";
  return env;
}

/** Build a minimal, safe environment for Codex CLI subprocesses. */
export function buildSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  for (const key of ALLOWED_ENV_KEYS) {
    const val = process.env[key];
    if (val) {
      env[key] = val;
    }
  }

  return env;
}
