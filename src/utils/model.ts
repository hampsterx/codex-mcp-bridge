/** Model capability tier. */
export type ModelTier = "fast" | "standard" | "powerful";

/** Static metadata about a supported model. */
export interface ModelInfo {
  id: string;
  tier: ModelTier;
  description: string;
  isDefault: boolean;
}

/**
 * Static list of models known to work with Codex CLI.
 * Updated at release time. Order: fast -> standard -> powerful.
 */
const SUPPORTED_MODELS: Omit<ModelInfo, "isDefault">[] = [
  { id: "gpt-4.1",  tier: "fast",     description: "Previous gen, lower cost, good speed" },
  { id: "o3",       tier: "standard",  description: "Reasoning model, default fallback when quota exhausted" },
  { id: "gpt-5.4",  tier: "powerful",  description: "Latest flagship model, highest capability" },
];

/**
 * Return supported models with `isDefault` resolved at call time
 * against the configured default model.
 */
export function getSupportedModels(): ModelInfo[] {
  const defaultModel = getDefaultModel();
  return SUPPORTED_MODELS.map((m) => ({
    ...m,
    isDefault: m.id === defaultModel,
  }));
}

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
