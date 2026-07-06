import stripAnsi from "strip-ansi";

export interface CodexOutput {
  /** The main text response from Codex. */
  response: string;
  /** Extracted thread/conversation ID for session resume. */
  threadId?: string;
  /** Raw parsed JSON (full structure from CLI). */
  raw?: unknown;
}

/**
 * Known patterns for potential secrets in CLI output.
 * Used to redact before returning to MCP client.
 */
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,           // OpenAI API keys
  /sk-ant-api[a-zA-Z0-9_-]{20,}/g,    // Anthropic API keys
  /AKIA[0-9A-Z]{16}/g,                 // AWS access key IDs
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,   // Bearer tokens
  /token[=:]\s*["']?[a-zA-Z0-9._-]{20,}["']?/gi,  // Generic tokens
];

/**
 * Redact potential secrets from CLI output.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/**
 * Parse Codex CLI output.
 *
 * Codex CLI can emit JSONL events with --json. Current versions write those
 * events to stdout and may still print session metadata to stderr.
 *
 * Strategy:
 * 1. Try JSONL event parsing from stdout (--json mode primary path)
 * 2. Try JSONL event parsing from stderr (fallback / older variants)
 * 3. Try stdout as JSON
 * 4. Try stderr as JSON
 * 5. Fall back to ANSI-stripped plain text from stdout, then stderr
 * 6. Error if both streams are empty
 */
export function parseCodexOutput(stdout: string, stderr: string): CodexOutput {
  const cleanedStdout = redactSecrets(stripAnsi(stdout).trim());
  const cleanedStderr = redactSecrets(stripAnsi(stderr).trim());

  // Try JSONL event parsing from stdout (Codex --json mode primary path)
  if (cleanedStdout.length > 0) {
    const jsonlResult = tryParseJsonlEvents(cleanedStdout);
    if (jsonlResult) return jsonlResult;
  }

  // Try JSONL event parsing from stderr as fallback
  if (cleanedStderr.length > 0) {
    const jsonlResult = tryParseJsonlEvents(cleanedStderr);
    if (jsonlResult) return jsonlResult;
  }

  // Try stdout as JSON
  if (cleanedStdout.length > 0) {
    try {
      const parsed = JSON.parse(cleanedStdout);
      return extractFromJson(parsed);
    } catch {
      // Not JSON
    }
  }

  // Try stderr as JSON (single JSON object)
  if (cleanedStderr.length > 0) {
    try {
      const parsed = JSON.parse(cleanedStderr);
      return extractFromJson(parsed);
    } catch {
      // Try extracting JSON from mixed output
      const jsonStart = cleanedStderr.indexOf("{");
      const jsonEnd = cleanedStderr.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        try {
          const parsed = JSON.parse(cleanedStderr.slice(jsonStart, jsonEnd + 1));
          return extractFromJson(parsed);
        } catch {
          // Not valid JSON
        }
      }
    }
  }

  // Session ID fallback from stderr for non-JSON mode
  const sessionMatch = cleanedStderr.match(/^session id:\s+([0-9a-f-]+)$/im);
  const threadId = sessionMatch?.[1];

  // Plain text fallback from stdout
  if (cleanedStdout.length > 0) {
    return { response: cleanedStdout, threadId };
  }

  // Plain text fallback from stderr
  if (cleanedStderr.length > 0) {
    return { response: cleanedStderr, threadId };
  }

  throw new Error("Codex CLI produced no output");
}

/**
 * Try to parse JSONL events from Codex CLI --json output.
 * Looks for thread.started (thread_id) and item.completed agent messages.
 *
 * Fatal failures (`turn.failed`, top-level `error`) are surfaced by throwing:
 * the tool handlers in index.ts map a thrown error to an MCP `isError: true`
 * result, so a rate-limited, model-errored, or tool-crashed turn reaches the
 * caller as a real failure instead of an empty-but-OK response. Non-fatal
 * item-level errors (`item.type === "error"`) are left as successful runs.
 */
function tryParseJsonlEvents(text: string): CodexOutput | null {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  let threadId: string | undefined;
  const responseParts: string[] = [];
  let hasKnownEvents = false;
  let fatalMessage: string | undefined;
  let hasFatalFailure = false;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;

      // Only claim this as JSONL if we see known Codex event types
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        hasKnownEvents = true;
        threadId = event.thread_id;
      }

      // Current CLI emits the final agent text on item.completed
      if (event.type === "item.completed" && event.item && typeof event.item === "object") {
        hasKnownEvents = true;
        const item = event.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string") {
          responseParts.push(item.text);
        }
      }

      if (event.type === "turn.completed") {
        hasKnownEvents = true;
      }

      // Fatal: the whole turn errored. Shape: { type: "turn.failed", error: { message } }
      if (event.type === "turn.failed") {
        hasKnownEvents = true;
        hasFatalFailure = true;
        const error = event.error;
        if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
          fatalMessage = (error as Record<string, unknown>).message as string;
        }
      }

      // Fatal: unrecoverable stream error. Shape: { type: "error", message }
      if (event.type === "error") {
        hasKnownEvents = true;
        hasFatalFailure = true;
        if (typeof event.message === "string") {
          fatalMessage = event.message;
        }
      }
    } catch {
      // Not JSON, skip line
    }
  }

  if (!hasKnownEvents) return null;

  // A fatal failure must not reach the caller as a successful empty response.
  // Throw so the tool handler surfaces it as an MCP error (isError: true).
  // Keep the exact upstream detail when present; make the detail-less fallback
  // actionable so a bare failure still tells the caller what to check.
  if (hasFatalFailure) {
    const detail = fatalMessage?.trim();
    throw new Error(
      detail
        ? detail
        : "Codex turn failed with no error detail. Check Codex CLI auth, quota, and model, then retry.",
    );
  }

  const response = responseParts.join("\n\n") || "(no response content in JSONL events)";
  return { response, threadId, raw: lines };
}

/**
 * Extract the response text from Codex's JSON output.
 */
function extractFromJson(parsed: unknown): CodexOutput {
  if (typeof parsed === "string") {
    return { response: parsed };
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    // Extract thread_id if present
    const threadId = typeof obj["thread_id"] === "string" ? obj["thread_id"] : undefined;

    // Try common response fields
    for (const key of ["response", "text", "content", "message", "output"]) {
      if (typeof obj[key] === "string") {
        return { response: obj[key] as string, threadId, raw: parsed };
      }
    }

    // Nested: result.response or result.text
    if (obj["result"] && typeof obj["result"] === "object") {
      const result = obj["result"] as Record<string, unknown>;
      for (const key of ["response", "text", "content"]) {
        if (typeof result[key] === "string") {
          return { response: result[key] as string, threadId, raw: parsed };
        }
      }
    }

    // Last resort: stringify the whole thing
    return { response: JSON.stringify(parsed, null, 2), threadId, raw: parsed };
  }

  return { response: String(parsed) };
}

/** Maximum size of text to attempt JSON parsing on (1MB). */
const MAX_EXTRACT_SIZE = 1_000_000;

/**
 * Extract a JSON value from model output text.
 *
 * The model may return raw JSON, JSON inside markdown fences, or JSON
 * surrounded by explanatory text. Tries progressively looser strategies.
 */
export function extractJson(text: string): { json: unknown; raw: string } | null {
  if (!text || text.length > MAX_EXTRACT_SIZE) return null;

  // 1. Try parsing the full text as JSON
  try {
    return { json: JSON.parse(text), raw: text };
  } catch { /* continue */ }

  // 2. Strip markdown code fences and try the fenced content
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    try {
      return { json: JSON.parse(fenced[1]), raw: fenced[1] };
    } catch { /* continue */ }
  }

  // 3. Find first {/[ and last }/] and try that slice
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  const start =
    objStart === -1 ? arrStart :
    arrStart === -1 ? objStart :
    Math.min(objStart, arrStart);
  if (start !== -1) {
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (end > start) {
      try {
        const slice = text.slice(start, end + 1);
        return { json: JSON.parse(slice), raw: slice };
      } catch { /* continue */ }
    }
  }

  return null;
}
