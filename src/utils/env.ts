/**
 * Hardened subprocess environment builder.
 * Never spreads process.env — uses an explicit allowlist.
 *
 * Per plan review: explicit keys only, not wildcard OPENAI_* (too broad,
 * risks leaking unintended config).
 */

import { readCodexConfig, listMcpServers, buildMcpArgs } from "./codex-config.js";

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
 *      per-server via `-c mcp_servers.NAME.enabled=false`. A blanket
 *      `mcp_servers={}` override silently no-ops on older Codex due to
 *      config-merge semantics (upstream #16045), so enumeration is the
 *      only reliable path.
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
 */
export function getMcpServerOverride(
  override?: string,
  { silent = false }: { silent?: boolean } = {},
): string[] {
  const envValue = process.env["CODEX_MCP_SERVERS"];
  // "Explicit" means the caller or the env var provided a value (even if it's
  // an empty string or whitespace). Truly-unset = both undefined.
  const explicit = override !== undefined || envValue !== undefined;
  const raw = override !== undefined ? override : envValue;
  const val = raw?.trim() ?? "";

  if (val === "") return disableNonRequiredServers(explicit, silent);
  if (val === "inherit") return [];
  if (val[0] === "{" || val[0] === "[") return rawTomlOverride(val);
  return enableListedServers(val, silent);
}

/**
 * Disable all non-required MCP servers.
 * When `explicit` is true and `silent` is false, warnings are emitted
 * for required servers that cannot be disabled.
 */
function disableNonRequiredServers(explicit: boolean, silent: boolean): string[] {
  const configured = listMcpServers(readCodexConfig());
  if (explicit && !silent) {
    return buildMcpArgs(configured, new Set<string>());
  }
  return buildMcpArgs(configured);
}

/** Pass raw TOML through as a `-c` flag. */
function rawTomlOverride(val: string): string[] {
  return ["-c", `mcp_servers=${val}`];
}

/**
 * Parse a comma-separated list of server names to enable.
 * Unknown names are warned (unless silent) and dropped.
 */
function enableListedServers(val: string, silent: boolean): string[] {
  const requested = val
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const config = readCodexConfig();
  const configured = listMcpServers(config);
  const configuredNames = new Set(configured.map((s) => s.name));

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

  return buildMcpArgs(configured, enabled, { silent });
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
