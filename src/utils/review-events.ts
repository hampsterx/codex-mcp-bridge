import stripAnsi from "strip-ansi";
import { redactSecrets } from "./parse.js";

export interface ReviewEvent {
  type?: string;
  thread_id?: string;
  item?: Record<string, unknown>;
  usage?: unknown;
  [key: string]: unknown;
}

export interface ReviewCommand {
  id?: string;
  command?: string | string[];
  aggregatedOutput?: string;
  exitCode?: number;
  status?: string;
}

export interface ReviewMeta {
  eventCounts: Record<string, number>;
  parseFailures: number;
  threadId?: string;
  turnsStarted: number;
  turnsCompleted: number;
  commands: ReviewCommand[];
  reasoningSummaries: string[];
  /**
   * Set when a fatal `turn.failed` event is seen. `parseReviewStream` stays
   * non-throwing; the review tool reads this and surfaces the failure as an MCP
   * error instead of returning partial output. (Top-level `error` events are
   * transient stream retries, not fatal.)
   */
  fatalError?: string;
}

export interface ReviewParseResult {
  finalText: string | null;
  meta: ReviewMeta;
}

/**
 * Parse Codex native review JSONL events.
 *
 * The review subcommand owns the prompt and emits JSONL progress. This parser
 * extracts only durable metadata and the last agent message while tolerating
 * unknown future event types.
 */
export function parseReviewStream(stdout: string): ReviewParseResult {
  const meta: ReviewMeta = {
    eventCounts: {},
    parseFailures: 0,
    turnsStarted: 0,
    turnsCompleted: 0,
    commands: [],
    reasoningSummaries: [],
  };
  let finalText: string | null = null;
  const rawFallbackLines: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      meta.parseFailures++;
      rawFallbackLines.push(rawLine);
      continue;
    }

    // Classify fatal and error-shaped events before extractFallbackText so a
    // top-level `error` is not mined as review text via its `message` field.
    //
    // Only `turn.failed` is a reliable fatal signal. Codex emits a top-level
    // `error` event for transient stream retries too (e.g. "Reconnecting...
    // 1/5", a ServerNotification::Error with will_retry) and keeps the stream
    // running, so treating `error` as fatal would abort a review that recovers.
    // A genuine failure always terminates in `turn.failed`, whose message
    // carries the last critical error. Count `error` so the stream is still
    // recognized as events, but do not mine it as review text or fail on it.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const eventType = (parsed as Record<string, unknown>).type;
      if (eventType === "turn.failed") {
        meta.eventCounts["turn.failed"] = (meta.eventCounts["turn.failed"] ?? 0) + 1;
        meta.fatalError =
          extractFatalMessage(parsed as ReviewEvent) ??
          "Codex review turn failed with no error detail. Check Codex CLI auth, quota, and model, then retry.";
        continue;
      }
      if (eventType === "error") {
        meta.eventCounts["error"] = (meta.eventCounts["error"] ?? 0) + 1;
        continue;
      }
    }

    const fallback = extractFallbackText(parsed);
    if (fallback) {
      finalText = fallback;
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const text = sanitize(String(parsed));
      if (text) finalText = text;
      continue;
    }

    const event = parsed as ReviewEvent;

    const eventType = typeof event.type === "string" ? event.type : "unknown";
    meta.eventCounts[eventType] = (meta.eventCounts[eventType] ?? 0) + 1;

    if (eventType === "thread.started" && typeof event.thread_id === "string") {
      meta.threadId = event.thread_id;
    } else if (eventType === "turn.started") {
      meta.turnsStarted++;
    } else if (eventType === "turn.completed") {
      meta.turnsCompleted++;
    }

    const item = event.item;
    if (!item || typeof item !== "object") continue;

    if (item.type === "agent_message" && typeof item.text === "string") {
      finalText = sanitize(item.text);
      continue;
    }

    if (item.type === "command_execution") {
      meta.commands.push(extractCommand(item));
      continue;
    }

    if (item.type === "reasoning") {
      meta.reasoningSummaries.push(...extractReasoningSummaries(item));
    }
  }

  if (!finalText && rawFallbackLines.length > 0) {
    finalText = extractRawFallbackText(rawFallbackLines);
  }

  return { finalText, meta };
}

function extractCommand(item: Record<string, unknown>): ReviewCommand {
  const command: ReviewCommand = {};

  if (typeof item.id === "string") command.id = item.id;
  if (typeof item.status === "string") command.status = item.status;
  if (typeof item.exit_code === "number") command.exitCode = item.exit_code;
  if (typeof item.exitCode === "number") command.exitCode = item.exitCode;

  if (typeof item.command === "string") {
    command.command = sanitize(item.command);
  } else if (Array.isArray(item.command)) {
    const parts = item.command.filter((part): part is string => typeof part === "string");
    if (parts.length > 0) command.command = parts.map(sanitize);
  } else if (typeof item.cmd === "string") {
    command.command = sanitize(item.cmd);
  } else if (Array.isArray(item.cmd)) {
    const parts = item.cmd.filter((part): part is string => typeof part === "string");
    if (parts.length > 0) command.command = parts.map(sanitize);
  }

  for (const key of ["aggregated_output", "aggregatedOutput", "output"]) {
    if (typeof item[key] === "string") {
      command.aggregatedOutput = sanitize(item[key]);
      break;
    }
  }

  return command;
}

function extractReasoningSummaries(item: Record<string, unknown>): string[] {
  const summaries: string[] = [];
  for (const key of ["summary", "text"]) {
    if (typeof item[key] === "string") summaries.push(sanitize(item[key]));
  }
  if (Array.isArray(item.summary)) {
    for (const entry of item.summary) {
      if (typeof entry === "string") summaries.push(sanitize(entry));
      else if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") {
        summaries.push(sanitize((entry as Record<string, string>).text));
      }
    }
  }
  return summaries;
}

/**
 * Extract the failure message from a `turn.failed` event
 * (`{ type: "turn.failed", error: { message } }`). Returns undefined when no
 * usable detail is present (caller supplies a generic actionable fallback).
 */
function extractFatalMessage(event: ReviewEvent): string | undefined {
  // Some shapes carry the detail at the top level: { message }
  if (typeof event.message === "string" && event.message.trim()) {
    return sanitize(event.message.trim());
  }
  // turn.failed: { type: "turn.failed", error: { message } }
  const err = event.error;
  if (err && typeof err === "object" && !Array.isArray(err)) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim()) {
      return sanitize(msg.trim());
    }
  }
  return undefined;
}

function sanitize(text: string): string {
  return redactSecrets(stripAnsi(text));
}

function extractRawFallbackText(lines: string[]): string | null {
  const raw = lines.join("\n").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    return extractFallbackText(parsed);
  } catch {
    return sanitize(raw);
  }
}

function extractFallbackText(parsed: unknown): string | null {
  if (typeof parsed === "string") {
    return sanitize(parsed);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of ["response", "text", "content", "message", "output"]) {
    if (typeof obj[key] === "string") {
      return sanitize(obj[key]);
    }
  }

  if (obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)) {
    const result = obj.result as Record<string, unknown>;
    for (const key of ["response", "text", "content"]) {
      if (typeof result[key] === "string") {
        return sanitize(result[key]);
      }
    }
  }

  return null;
}
