import { extractFatalMessageFromJsonl } from "./parse.js";

/** Free-text rate-limit / quota patterns, shared by stderr and stdout-fatal classification. */
const RETRYABLE_TEXT_PATTERNS = ["rate limit", "too many requests", "429", "quota", "resource_exhausted", "rate_limit_exceeded"];

/** Does this text name a rate-limit / quota condition? */
function matchesRetryableText(text: string): boolean {
  const lower = text.toLowerCase();
  return RETRYABLE_TEXT_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Non-throwing check: does this result look like a retryable quota/rate-limit error?
 * Used by the fallback wrapper to decide whether to retry with a different model.
 * Must be called BEFORE checkErrorPatterns (which throws).
 *
 * Two failure surfaces are classified:
 *   - stderr text / structured JSON on a non-zero exit (the original path).
 *   - a `turn.failed` / terminal `error` event on stdout JSONL with a rate-limit
 *     message and exit 0 (since #31/#33, Codex can report a rate-limited turn
 *     this way with clean stderr). Only the same rate-limit/quota subset retries;
 *     other fatals (context length, tool crash) fall through to parseCodexOutput.
 */
export function isRetryableError(exitCode: number | null, stderr: string, stdout?: string): boolean {
  // stderr classification: a non-zero exit whose stderr names a rate-limit/quota condition.
  if (exitCode !== 0 && stderr) {
    if (matchesRetryableText(stderr)) return true;

    // Structured JSON error object on stderr.
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
  }

  // stdout JSONL classification: match the same patterns against the extracted
  // fatal message so a rate-limited turn reported on stdout (exit 0) still retries.
  if (stdout) {
    const fatal = extractFatalMessageFromJsonl(stdout);
    if (fatal && matchesRetryableText(fatal)) return true;
  }

  return false;
}

/**
 * Check stderr for common Codex CLI error patterns and throw
 * a user-friendly error. Called by all tool implementations.
 *
 * When `stdout` is provided and non-empty, generic non-zero exits are
 * not thrown (the CLI produced a response despite the exit code).
 */
export function checkErrorPatterns(exitCode: number | null, stderr: string, stdout?: string): void {
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
    // Generic non-zero exit: throw when the CLI failed without producing output.
    // If stdout has content, the response is salvageable despite the exit code.
    // NOTE: partial JSONL progress events in stdout could mask a real failure.
    // A more precise check (verifying a parsed response exists) requires running
    // parseCodexOutput first, which is a pipeline-level restructuring (Phase 1).
    if (!stdout || !stdout.trim()) {
      throw new Error(
        `Codex CLI exited with code ${exitCode}: ${stderr.trim()}`,
      );
    }
  }
}

/**
 * Safely extract an error message from an unknown thrown value.
 * Replaces unsafe `(e as Error).message` casts that return `undefined`
 * when the thrown value is a string or plain object.
 */
export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause;
    if (cause instanceof Error) {
      return `${e.message}: ${cause.message}`;
    }
    return e.message;
  }
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
