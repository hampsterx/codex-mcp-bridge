import stripAnsi from "strip-ansi";

/** Per-turn token usage reported by Codex exec on `turn.completed`. */
export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface CodexOutput {
  /** The main text response from Codex. */
  response: string;
  /** Extracted thread/conversation ID for session resume. */
  threadId?: string;
  /** Per-turn token usage, when the stream includes a `turn.completed`. */
  usage?: CodexUsage;
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
 * Result of scanning Codex --json (JSONL) output for the events that matter to
 * both the parsing path (`tryParseJsonlEvents`) and the retry classifier
 * (`extractFatalMessageFromJsonl`). One scan, one place the classification rules
 * live, so the two consumers can never drift apart.
 */
interface JsonlScan {
  /** True once any recognized Codex event type is seen. */
  hasKnownEvents: boolean;
  /** thread_id from `thread.started`, for session resume. */
  threadId?: string;
  /** Agent text collected from `item.completed` agent_message items, in order. */
  responseParts: string[];
  /** A `turn.failed` event was seen (always fatal). */
  hasFatalFailure: boolean;
  /** `turn.failed` -> `error.message`, when present. */
  fatalMessage?: string;
  /** Last top-level `error` event message (fatal only when the turn never recovers). */
  lastErrorMessage?: string;
  /** A `turn.completed` event was seen (marks recovery for the terminal-error gate). */
  sawTurnCompleted: boolean;
  /** Accumulated per-turn token usage across all `turn.completed` events. */
  usage?: CodexUsage;
  /** Non-empty input lines, retained for the parsed `raw` payload. */
  lines: string[];
}

/**
 * Scan JSONL event lines once and collect the classification signals both
 * consumers need. Non-JSON lines are skipped. This owns the event-shape rules
 * (which `type`s count, where the fatal message lives, what marks recovery);
 * the consumers only decide what to DO with the result (throw vs return).
 */
function scanJsonlEvents(text: string): JsonlScan {
  const lines = text.split("\n").filter(Boolean);
  const scan: JsonlScan = {
    hasKnownEvents: false,
    responseParts: [],
    hasFatalFailure: false,
    sawTurnCompleted: false,
    lines,
  };

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not JSON, skip line
      continue;
    }

    // Only claim this as JSONL if we see known Codex event types
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      scan.hasKnownEvents = true;
      scan.threadId = event.thread_id;
    }

    // Current CLI emits the final agent text on item.completed
    if (event.type === "item.completed" && event.item && typeof event.item === "object") {
      scan.hasKnownEvents = true;
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        scan.responseParts.push(item.text);
      }
    }

    if (event.type === "turn.completed") {
      scan.hasKnownEvents = true;
      scan.sawTurnCompleted = true;
      // Usage is documented as per-turn (codex-rs Usage: "tokens used during
      // the turn"). A single `codex exec` is one turn, but accumulate across
      // any turn.completed events so a multi-turn stream reports the true total
      // rather than only the last turn.
      const parsedUsage = extractUsage(event.usage);
      if (parsedUsage) scan.usage = addUsage(scan.usage, parsedUsage);
    }

    // Fatal: the whole turn errored. Shape: { type: "turn.failed", error: { message } }
    if (event.type === "turn.failed") {
      scan.hasKnownEvents = true;
      scan.hasFatalFailure = true;
      const error = event.error;
      if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
        scan.fatalMessage = (error as Record<string, unknown>).message as string;
      }
    }

    // A top-level `error` event is NOT inherently fatal: Codex emits it for
    // transient stream retries ("Reconnecting... N/5", a
    // ServerNotification::Error with will_retry) and keeps the stream running,
    // so failing on it would abort a turn that recovers. Recognize it as a
    // known event and remember its message, but only surface it as a failure
    // if the turn never recovers (terminal-error gate in the consumers). A
    // recovered turn produces agent output and/or turn.completed; a genuine
    // unrecovered failure usually terminates in turn.failed.
    if (event.type === "error") {
      scan.hasKnownEvents = true;
      if (typeof event.message === "string") {
        scan.lastErrorMessage = event.message;
      }
    }
  }

  return scan;
}

/**
 * A terminal top-level `error` event is fatal only when the turn never
 * recovered: no agent output and no `turn.completed`. A transient reconnect
 * recovers and is filtered out here because it yields responseParts and/or a
 * turn.completed. Shared by both consumers so the gate stays identical.
 */
function isUnrecoveredTerminalError(scan: JsonlScan): boolean {
  return Boolean(scan.lastErrorMessage) && scan.responseParts.length === 0 && !scan.sawTurnCompleted;
}

/**
 * Try to parse JSONL events from Codex CLI --json output.
 * Looks for thread.started (thread_id) and item.completed agent messages.
 *
 * A fatal `turn.failed` is surfaced by throwing: the tool handlers in index.ts
 * map a thrown error to an MCP `isError: true` result, so a rate-limited,
 * model-errored, or tool-crashed turn reaches the caller as a real failure
 * instead of an empty-but-OK response. A top-level `error` event is treated as
 * fatal only when the turn does not recover (see isUnrecoveredTerminalError),
 * because Codex also emits `error` for transient stream retries and keeps
 * running. Non-fatal item-level errors (`item.type === "error"`) are also left
 * as successful runs.
 */
function tryParseJsonlEvents(text: string): CodexOutput | null {
  const scan = scanJsonlEvents(text);
  if (!scan.hasKnownEvents) return null;

  // A fatal failure must not reach the caller as a successful empty response.
  // Throw so the tool handler surfaces it as an MCP error (isError: true).
  // Keep the exact upstream detail when present; make the detail-less fallback
  // actionable so a bare failure still tells the caller what to check.
  if (scan.hasFatalFailure) {
    throw new Error(fatalDetail(scan.fatalMessage));
  }

  if (isUnrecoveredTerminalError(scan)) {
    throw new Error(fatalDetail(scan.lastErrorMessage));
  }

  const response = scan.responseParts.join("\n\n") || "(no response content in JSONL events)";
  return { response, threadId: scan.threadId, usage: scan.usage, raw: scan.lines };
}

/** Trim an upstream fatal message, falling back to an actionable default. */
function fatalDetail(message: string | undefined): string {
  const detail = message?.trim();
  return detail ? detail : "Codex turn failed with no error detail. Check Codex CLI auth, quota, and model, then retry.";
}

/**
 * Map a Codex exec `turn.completed` usage payload to a camelCase shape.
 *
 * Upstream shape (codex-rs/exec/src/exec_events.rs `Usage`, all i64):
 *   { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }
 *
 * Returns undefined when the payload is absent or not an object, so callers
 * can distinguish "no usage emitted" from a zeroed turn.
 */
function extractUsage(raw: unknown): CodexUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.input_tokens),
    cachedInputTokens: num(u.cached_input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(u.reasoning_output_tokens),
  };
}

/** Field-wise sum of two usage snapshots (undefined base returns the addend). */
function addUsage(base: CodexUsage | undefined, add: CodexUsage): CodexUsage {
  if (!base) return add;
  return {
    inputTokens: base.inputTokens + add.inputTokens,
    cachedInputTokens: base.cachedInputTokens + add.cachedInputTokens,
    outputTokens: base.outputTokens + add.outputTokens,
    reasoningTokens: base.reasoningTokens + add.reasoningTokens,
  };
}

/**
 * Non-throwing fatal-message extractor for Codex --json (JSONL) output.
 *
 * Returns the upstream fatal message so a caller (e.g. the model-fallback retry
 * classifier in errors.ts) can decide whether the failure is retryable WITHOUT
 * the throwing side-effect that `parseCodexOutput` / `tryParseJsonlEvents`
 * carry. Shares `scanJsonlEvents` with the throwing path, so the classification
 * (which fatals count, the terminal-error recovery gate) can never drift; the
 * only difference is that this consumer returns the message instead of throwing.
 *
 *   - `turn.failed` -> its `error.message` (a turn.failed is always fatal).
 *   - a top-level `error` event -> its `message`, but only when the turn never
 *     recovered (see isUnrecoveredTerminalError).
 *
 * Returns undefined for a happy stream, a non-fatal item-level error, a
 * recovered transient error, or a fatal event that carried no message string
 * (there is nothing to pattern-match; the generic "no detail" fallback text is
 * left to the throwing path so it never leaks into rate-limit classification).
 */
export function extractFatalMessageFromJsonl(text: string): string | undefined {
  const scan = scanJsonlEvents(text);

  // A turn.failed is always fatal; return its upstream message (or undefined if
  // it was detail-less). It takes precedence over the top-level error path,
  // matching tryParseJsonlEvents' short-circuit on hasFatalFailure.
  if (scan.hasFatalFailure) return scan.fatalMessage;

  if (isUnrecoveredTerminalError(scan)) return scan.lastErrorMessage;

  return undefined;
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
