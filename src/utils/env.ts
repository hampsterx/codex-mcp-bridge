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
 *                  `review.ts` agentic mode defaults to `"serena"`).
 * @param options.silent  Suppress "unknown server" and "refusing to disable
 *                  required" warnings. Set by callers passing an implicit
 *                  tool default (e.g. `review.ts` when the user did not
 *                  specify anything) so users who never asked for a list
 *                  don't get yelled at for the bridge's internal preferences.
 */
export function getMcpServerOverride(
  override?: string,
  { silent = false }: { silent?: boolean } = {},
): string[] {
  const raw = override !== undefined ? override : process.env["CODEX_MCP_SERVERS"];
  const val = raw?.trim() ?? "";

  // Branch 1: unset / empty / whitespace → disable all non-required.
  if (val === "") {
    const config = readCodexConfig();
    return buildMcpArgs(listMcpServers(config));
  }

  // Branch 2: inherit → passthrough.
  if (val === "inherit") {
    return [];
  }

  // Branch 3: raw TOML escape hatch (first non-ws char is { or [).
  const first = val[0];
  if (first === "{" || first === "[") {
    return ["-c", `mcp_servers=${val}`];
  }

  // Branch 4: comma-separated enable list.
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
