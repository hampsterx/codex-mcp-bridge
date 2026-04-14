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
 * Decide whether an MCP server will be effectively enabled for a subprocess
 * spawned with the given `CODEX_MCP_SERVERS` grammar value.
 *
 * Mirrors the branches in {@link getMcpServerOverride}:
 *
 *   - `""` / whitespace → disable-all, so only `required=true` servers survive.
 *   - `"inherit"` → check the user's config.toml; treat a configured server as
 *     enabled unless its entry explicitly sets `enabled=false`.
 *   - raw TOML (`{…}`/`[…]`) → intentionally conservative: return false even
 *     if the raw override would enable the server. Rationale: parsing arbitrary
 *     user-supplied TOML just to pick a prompt duplicates Codex's own parsing
 *     and introduces a new failure mode on malformed input. The raw-TOML branch
 *     is a power-user escape hatch, callers who want the serena prompt with
 *     raw TOML can also pass `mcpServers: "serena"` for the list branch or
 *     accept the generic prompt (Codex still has the tools at runtime, the
 *     generic prompt just doesn't advertise them).
 *   - comma-separated list → enabled iff the server is configured (so the
 *     caller didn't typo the name) AND either `name` (case-sensitive, trimmed)
 *     is in the list OR the server is `required=true` in config.toml.
 *
 * Used by `review.ts` to pick the serena-aware agentic prompt only when the
 * serena MCP will actually be available in the subprocess. Synchronous by
 * design, same config-read contract as `getMcpServerOverride`.
 */
export function willEnableServer(override: string, name: string): boolean {
  const val = override.trim();

  if (val === "") {
    const configured = listMcpServers(readCodexConfig());
    const entry = configured.find((s) => s.name === name);
    return entry?.required === true;
  }

  if (val === "inherit") {
    const config = readCodexConfig();
    const entry = config?.mcp_servers && typeof config.mcp_servers === "object"
      ? (config.mcp_servers as Record<string, unknown>)[name]
      : undefined;
    if (entry === undefined) return false;
    if (typeof entry === "object" && entry !== null) {
      const enabledField = (entry as Record<string, unknown>)["enabled"];
      if (enabledField === false) return false;
    }
    return true;
  }

  const first = val[0];
  if (first === "{" || first === "[") {
    return false;
  }

  const requested = new Set(
    val.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  );
  const configured = listMcpServers(readCodexConfig());
  const entry = configured.find((s) => s.name === name);
  if (!entry) return false; // not configured → can't be enabled even if named
  return requested.has(name) || entry.required;
}

// --- Review timeout coefficients ---------------------------------------
//
// Review depth tiers (scan/focused/deep) each get their own timeout budget.
// Values are exposed as env vars so an operator stuck on a repo where the
// defaults consistently fail can tune without a release. Scan is constant;
// focused and deep scale linearly with file count, capped.
//
// Defaults were chosen to match pre-depth behaviour where possible:
//   - scan 120s matches the old QUICK_TIMEOUT (no change for existing callers)
//   - deep 180 + 30/file matches v0.4.0 auto-scaling (no change for existing
//     agentic callers)
// Focused is new and picks a middle budget: 120 + 15/file, capped at 300s.
// Fallback-when-stat-unavailable values are separate because the per-file
// scaling can't apply without a file count.

function readTimeoutMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`codex-mcp-bridge: ignoring invalid ${key}='${raw}' (must be positive number of ms)`);
    return fallback;
  }
  return n;
}

/** Scan (diff-only, single-pass) timeout. Env: CODEX_REVIEW_SCAN_TIMEOUT_MS. */
export function scanTimeoutMs(): number {
  return readTimeoutMs("CODEX_REVIEW_SCAN_TIMEOUT_MS", 120_000);
}

/** Focused review: base + per-file * files, capped. Pre-inlined diff + read changed files. */
export function focusedBaseMs(): number {
  return readTimeoutMs("CODEX_REVIEW_FOCUSED_BASE_MS", 120_000);
}
export function focusedPerFileMs(): number {
  return readTimeoutMs("CODEX_REVIEW_FOCUSED_PER_FILE_MS", 15_000);
}
export function focusedCapMs(): number {
  return readTimeoutMs("CODEX_REVIEW_FOCUSED_CAP_MS", 300_000);
}
/** Fallback when diff stat unavailable (can't compute file-count term). */
export function focusedFallbackMs(): number {
  return readTimeoutMs("CODEX_REVIEW_FOCUSED_FALLBACK_MS", 240_000);
}

/** Deep (agentic) review: base + per-file * files, capped at HARD_TIMEOUT_CAP. */
export function deepBaseMs(): number {
  return readTimeoutMs("CODEX_REVIEW_DEEP_BASE_MS", 180_000);
}
export function deepPerFileMs(): number {
  return readTimeoutMs("CODEX_REVIEW_DEEP_PER_FILE_MS", 30_000);
}
/** Fallback when diff stat unavailable. */
export function deepFallbackMs(): number {
  return readTimeoutMs("CODEX_REVIEW_DEEP_FALLBACK_MS", 600_000);
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
