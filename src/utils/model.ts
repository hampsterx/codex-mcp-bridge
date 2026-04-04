/**
 * Return the configured default model from CODEX_DEFAULT_MODEL.
 * Treats empty/whitespace-only strings as unset.
 */
export function getDefaultModel(): string | undefined {
  return process.env["CODEX_DEFAULT_MODEL"]?.trim() || undefined;
}

/** Default fallback model when quota is exhausted. */
const DEFAULT_FALLBACK_MODEL = "o3";

/**
 * Return the configured fallback model for quota exhaustion retries.
 * Returns undefined if explicitly disabled via "none".
 * Defaults to o3 when unset.
 */
export function getFallbackModel(): string | undefined {
  const value = process.env["CODEX_FALLBACK_MODEL"]?.trim();
  if (value?.toLowerCase() === "none") return undefined;
  return value || DEFAULT_FALLBACK_MODEL;
}

/**
 * Resolve the Codex model to use, applying precedence:
 * 1. Explicit `model` parameter (caller override)
 * 2. `CODEX_DEFAULT_MODEL` env var (server-level default)
 * 3. undefined (let the CLI use its own default)
 */
export function resolveModel(explicit?: string): string | undefined {
  return explicit?.trim() || getDefaultModel();
}
