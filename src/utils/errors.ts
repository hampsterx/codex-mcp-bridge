/**
 * Non-throwing check: does this result look like a retryable quota/rate-limit error?
 * Used by the fallback wrapper to decide whether to retry with a different model.
 * Must be called BEFORE checkErrorPatterns (which throws).
 */
export function isRetryableError(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 0 || !stderr) return false;

  const lower = stderr.toLowerCase();

  // Free-text pattern matching
  const textPatterns = ["rate limit", "too many requests", "429", "quota", "resource_exhausted", "rate_limit_exceeded"];
  if (textPatterns.some((p) => lower.includes(p))) return true;

  // Structured JSON matching
  try {
    const parsed = JSON.parse(stderr) as Record<string, unknown>;
    const error = (parsed.error ?? parsed) as Record<string, unknown>;
    const code = String(error.code ?? "").toUpperCase();
    const status = String(error.status ?? "").toUpperCase();
    const retryableCodes = ["RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", "429", "RATE_LIMIT_EXCEEDED"];
    if (retryableCodes.includes(code) || retryableCodes.includes(status)) return true;
  } catch {
    // Not JSON, already checked free-text above
  }

  return false;
}

/**
 * Check stderr for common Codex CLI error patterns and throw
 * a user-friendly error. Called by all tool implementations.
 */
export function checkErrorPatterns(exitCode: number | null, stderr: string): void {
  if (exitCode !== 0 && stderr) {
    const lower = stderr.toLowerCase();
    if (lower.includes("api key") || lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("invalid_api_key")) {
      throw new Error(
        `Codex CLI authentication error. Set OPENAI_API_KEY or run: codex auth login\n\nDetails: ${stderr.trim()}`,
      );
    }
    if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429") || lower.includes("quota")) {
      throw new Error(
        `OpenAI API rate limit hit. Wait and retry.\n\nDetails: ${stderr.trim()}`,
      );
    }
  }
}
