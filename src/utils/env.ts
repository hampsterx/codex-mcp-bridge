/**
 * Hardened subprocess environment builder.
 * Never spreads process.env — uses an explicit allowlist.
 *
 * Per plan review: explicit keys only, not wildcard OPENAI_* (too broad,
 * risks leaking unintended config).
 */

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
