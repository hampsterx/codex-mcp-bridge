import { describe, expect, it } from "vitest";
import { buildMeta } from "../../src/utils/meta.js";

describe("buildMeta", () => {
  it("always includes durationMs", () => {
    const meta = buildMeta({ durationMs: 1234 });
    expect(meta).toEqual({ durationMs: 1234 });
  });

  it("includes model when provided", () => {
    const meta = buildMeta({ model: "o3", durationMs: 500 });
    expect(meta).toEqual({ model: "o3", durationMs: 500 });
  });

  it("includes fallbackUsed as boolean true when set", () => {
    const meta = buildMeta({ durationMs: 100, fallbackUsed: true });
    expect(meta.fallbackUsed).toBe(true);
  });

  it("omits fallbackUsed when false or undefined", () => {
    expect(buildMeta({ durationMs: 100, fallbackUsed: false })).not.toHaveProperty("fallbackUsed");
    expect(buildMeta({ durationMs: 100 })).not.toHaveProperty("fallbackUsed");
  });

  it("includes sessionId and conversationId for codex tool", () => {
    const meta = buildMeta({
      model: "o3",
      durationMs: 2000,
      sessionId: "codex-123",
      conversationId: "thread_abc",
    });
    expect(meta).toEqual({
      model: "o3",
      durationMs: 2000,
      sessionId: "codex-123",
      conversationId: "thread_abc",
    });
  });

  it("omits sessionId and conversationId when not provided", () => {
    const meta = buildMeta({ model: "o3", durationMs: 100 });
    expect(meta).not.toHaveProperty("sessionId");
    expect(meta).not.toHaveProperty("conversationId");
  });

  it("includes all fields together", () => {
    const meta = buildMeta({
      model: "gpt-4.1",
      durationMs: 5000,
      fallbackUsed: true,
      sessionId: "sess-1",
      conversationId: "conv-1",
    });
    expect(meta).toEqual({
      model: "gpt-4.1",
      durationMs: 5000,
      fallbackUsed: true,
      sessionId: "sess-1",
      conversationId: "conv-1",
    });
  });

  it("omits model when undefined", () => {
    const meta = buildMeta({ durationMs: 100 });
    expect(meta).not.toHaveProperty("model");
  });

  it("includes usage when provided", () => {
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 8,
    };
    const meta = buildMeta({ durationMs: 300, usage });
    expect(meta.usage).toEqual(usage);
  });

  it("omits usage when not provided", () => {
    const meta = buildMeta({ durationMs: 100 });
    expect(meta).not.toHaveProperty("usage");
  });
});
