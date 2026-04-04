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

  it("leaves non-secret text alone", () => {
    const text = "This is a normal response";
    expect(redactSecrets(text)).toBe(text);
  });
});
