import { describe, it, expect } from "vitest";
import { parseCodexOutput, extractJson, redactSecrets } from "../../src/utils/parse.js";

describe("parseCodexOutput", () => {
  it("parses plain text from stdout", () => {
    const result = parseCodexOutput("Hello world", "");
    expect(result.response).toBe("Hello world");
  });

  it("parses plain text from stderr (Codex primary output stream)", () => {
    const result = parseCodexOutput("", "Response from stderr");
    expect(result.response).toBe("Response from stderr");
  });

  it("parses JSON from stdout", () => {
    const json = JSON.stringify({ response: "test response" });
    const result = parseCodexOutput(json, "");
    expect(result.response).toBe("test response");
  });

  it("parses JSON from stderr", () => {
    const json = JSON.stringify({ text: "test text" });
    const result = parseCodexOutput("", json);
    expect(result.response).toBe("test text");
  });

  it("extracts JSON from mixed stderr", () => {
    const stderr = `Loading...\n${JSON.stringify({ content: "found it" })}\nDone`;
    const result = parseCodexOutput("", stderr);
    expect(result.response).toBe("found it");
  });

  it("throws on empty output", () => {
    expect(() => parseCodexOutput("", "")).toThrow("no output");
  });

  it("parses JSONL events from stdout with thread_id and agent message text", () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_abc123" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Review complete" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join("\n");
    const result = parseCodexOutput(events, "");
    expect(result.threadId).toBe("thread_abc123");
    expect(result.response).toBe("Review complete");
  });

  it("extracts session id from stderr fallback output", () => {
    const stderr = "session id: 019d5a9f-1234-5678-abcd-0123456789ab\nPlain response";
    const result = parseCodexOutput("", stderr);
    expect(result.threadId).toBe("019d5a9f-1234-5678-abcd-0123456789ab");
    expect(result.response).toContain("Plain response");
  });

  it("preserves session id from stderr when response is plain text on stdout", () => {
    const stdout = "The answer is 42";
    const stderr = "session id: 019d5a9f-aaaa-bbbb-cccc-0123456789ab";
    const result = parseCodexOutput(stdout, stderr);
    expect(result.threadId).toBe("019d5a9f-aaaa-bbbb-cccc-0123456789ab");
    expect(result.response).toBe("The answer is 42");
  });

  it("redacts API keys in output", () => {
    const result = parseCodexOutput("Key: sk-abcdefghijklmnopqrstuvwxyz", "");
    expect(result.response).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(result.response).toContain("[REDACTED]");
  });

  it("skips malformed JSONL lines and extracts valid events", () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_partial" }),
      "this is not valid json {{{",
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Partial success" },
      }),
    ].join("\n");
    const result = parseCodexOutput(events, "");
    expect(result.threadId).toBe("thread_partial");
    expect(result.response).toBe("Partial success");
  });

  it("concatenates multiple agent messages from JSONL", () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_multi" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Part one" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "Part two" },
      }),
    ].join("\n");
    const result = parseCodexOutput(events, "");
    expect(result.response).toContain("Part one");
    expect(result.response).toContain("Part two");
  });

  it("returns fallback message when JSONL has known events but no agent messages", () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_empty" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 0 } }),
    ].join("\n");
    const result = parseCodexOutput(events, "");
    expect(result.response).toBe("(no response content in JSONL events)");
    expect(result.threadId).toBe("thread_empty");
  });

  it("falls back to plain text when lines are valid JSON but not known event types", () => {
    const line1 = JSON.stringify({ action: "unknown", data: "value" });
    const line2 = JSON.stringify({ other: "stuff" });
    const output = [line1, line2].join("\n");
    // Neither object has a known type field, so tryParseJsonlEvents returns null.
    // Falls through to JSON parse which fails (multi-line), then to plain text.
    const result = parseCodexOutput(output, "");
    // Plain text fallback returns the full cleaned stdout, preserving both lines.
    expect(result.response).toContain(line1);
    expect(result.response).toContain(line2);
    expect(result.threadId).toBeUndefined();
  });

  it("throws with the message when a turn.failed event is present", () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_fail" }),
      JSON.stringify({ type: "turn.failed", error: { message: "rate limit exceeded" } }),
    ].join("\n");
    // A failed turn must surface as an error, not an empty successful response.
    expect(() => parseCodexOutput(events, "")).toThrow("rate limit exceeded");
  });

  it("throws a generic message when turn.failed has no error message", () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_fail" }),
      JSON.stringify({ type: "turn.failed" }),
    ].join("\n");
    expect(() => parseCodexOutput(events, "")).toThrow("Codex turn failed");
  });

  it("does not treat a top-level error event as fatal (transient reconnect) and recovers the response", () => {
    // Codex emits a top-level `error` event for transient stream retries and
    // keeps running, so a recovered turn must still return its real text.
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_reconnect" }),
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (Idle timeout waiting for SSE)" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "Recovered answer" },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const result = parseCodexOutput(events, "");
    expect(result.response).toBe("Recovered answer");
    expect(result.threadId).toBe("thread_reconnect");
  });

  it("throws a terminal top-level error when the turn never recovers", () => {
    // No agent output and no turn.completed after the error: treat it as fatal
    // rather than returning an empty "success".
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_terminal" }),
      JSON.stringify({ type: "error", message: "unrecoverable stream error" }),
    ].join("\n");
    expect(() => parseCodexOutput(events, "")).toThrow("unrecoverable stream error");
  });

  it("does not throw when a turn completes after a top-level error but yields no text", () => {
    // A completed (if empty) turn means the earlier error was transient.
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_empty_ok" }),
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const result = parseCodexOutput(events, "");
    expect(result.response).toBe("(no response content in JSONL events)");
  });

  it("does not throw on a non-fatal item-level error, returns the agent text", () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_item_err" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "a recoverable tool error" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "Recovered and finished" },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const result = parseCodexOutput(events, "");
    expect(result.response).toBe("Recovered and finished");
    expect(result.threadId).toBe("thread_item_err");
  });

  it("throws the failure when turn.failed follows a partial agent_message (fatal wins)", () => {
    // Contract: a fatal turn.failed discards any partial agent text and surfaces
    // the failure, rather than returning the partial text as a success.
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_partial_fail" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "partial work before failure" },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "context length exceeded" } }),
    ].join("\n");
    expect(() => parseCodexOutput(events, "")).toThrow("context length exceeded");
    expect(() => parseCodexOutput(events, "")).not.toThrow("partial work before failure");
  });
});

describe("parseCodexOutput edge cases", () => {
  it("prefers stdout JSONL over stderr JSONL", () => {
    const stdoutEvents = [
      JSON.stringify({ type: "thread.started", thread_id: "stdout_thread" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "From stdout" },
      }),
    ].join("\n");
    const stderrEvents = [
      JSON.stringify({ type: "thread.started", thread_id: "stderr_thread" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "From stderr" },
      }),
    ].join("\n");
    const result = parseCodexOutput(stdoutEvents, stderrEvents);
    expect(result.threadId).toBe("stdout_thread");
    expect(result.response).toBe("From stdout");
  });
});

describe("extractJson", () => {
  it("extracts raw JSON", () => {
    const result = extractJson('{"key": "value"}');
    expect(result).not.toBeNull();
    expect((result!.json as Record<string, string>).key).toBe("value");
  });

  it("extracts JSON from markdown fences", () => {
    const result = extractJson('```json\n{"key": "value"}\n```');
    expect(result).not.toBeNull();
    expect((result!.json as Record<string, string>).key).toBe("value");
  });

  it("extracts JSON from surrounding text", () => {
    const result = extractJson('Here is the result: {"key": "value"} and that is it.');
    expect(result).not.toBeNull();
    expect((result!.json as Record<string, string>).key).toBe("value");
  });

  it("returns null for non-JSON", () => {
    expect(extractJson("just plain text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJson("")).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("redacts OpenAI API keys", () => {
    expect(redactSecrets("key is sk-abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6")).toContain("[REDACTED]");
  });

  it("redacts AWS access key IDs", () => {
    expect(redactSecrets("AKIA1234567890ABCDEF")).toBe("[REDACTED]");
  });

  it("leaves non-secret text alone", () => {
    const text = "This is a normal response";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts multiple secrets in one string", () => {
    const text = "Key: sk-abcdefghijklmnopqrstuvwxyz and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6";
    const result = redactSecrets(text);
    expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6");
    expect((result.match(/\[REDACTED\]/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("redacts Anthropic API keys", () => {
    expect(redactSecrets("key: sk-ant-apiabc123def456ghi789jkl")).toContain("[REDACTED]");
  });

  it("redacts generic token assignments", () => {
    expect(redactSecrets("token=abc12345678901234567890")).toContain("[REDACTED]");
  });
});
