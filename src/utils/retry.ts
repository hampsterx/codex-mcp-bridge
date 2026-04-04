import type { SpawnResult } from "./spawn.js";
import { isRetryableError } from "./errors.js";
import { getFallbackModel } from "./model.js";

/** Minimum remaining time to attempt a fallback retry. */
const MIN_RETRY_BUDGET = 10_000;

/** Hard cap matching spawn.ts — total wall-clock for both attempts combined. */
export const HARD_TIMEOUT_CAP = 600_000;

export interface FallbackResult {
  result: SpawnResult;
  fallbackUsed: boolean;
  fallbackModel?: string;
}

/**
 * Wrap a spawnCodex call with automatic model fallback on quota exhaustion.
 *
 * Calls `spawnFn(model, timeout)` once. If the result is a retryable quota/rate-limit
 * error, retries with the configured fallback model (default: o3).
 * Total wall-clock time never exceeds `totalTimeout`.
 */
export async function withModelFallback(
  model: string | undefined,
  spawnFn: (model: string | undefined, timeout: number) => Promise<SpawnResult>,
  totalTimeout: number,
): Promise<FallbackResult> {
  const capped = Math.min(totalTimeout, HARD_TIMEOUT_CAP);
  const deadline = Date.now() + capped;

  const result = await spawnFn(model, capped);

  // Timeouts are not retryable
  if (result.timedOut) {
    return { result, fallbackUsed: false };
  }

  // Check if this is a retryable quota/rate-limit error
  if (!isRetryableError(result.exitCode, result.stderr)) {
    return { result, fallbackUsed: false };
  }

  const fallback = getFallbackModel();

  // Fallback disabled or same model (no point retrying)
  if (!fallback || fallback === model) {
    return { result, fallbackUsed: false };
  }

  const remaining = deadline - Date.now();
  if (remaining < MIN_RETRY_BUDGET) {
    return { result, fallbackUsed: false };
  }

  const retryResult = await spawnFn(fallback, remaining);

  return {
    result: retryResult,
    fallbackUsed: true,
    fallbackModel: fallback,
  };
}
