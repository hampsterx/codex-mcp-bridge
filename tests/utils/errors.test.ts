import { describe, it, expect } from "vitest";
import { isRetryableError, checkErrorPatterns, toErrorMessage } from "../../src/utils/errors.js";

describe("isRetryableError", () => {
  it("returns false for exit code 0", () => {
    expect(isRetryableError(0, "rate limit")).toBe(false);
  });

  it("returns false for empty stderr", () => {
    expect(isRetryableError(1, "")).toBe(false);
  });

  it("detects rate limit text", () => {
    expect(isRetryableError(1, "Error: rate limit exceeded")).toBe(true);
  });

  it("detects 429 status", () => {
    expect(isRetryableError(1, "HTTP 429 Too Many Requests")).toBe(true);
  });

  it("detects quota text", () => {
    expect(isRetryableError(1, "quota exceeded for today")).toBe(true);
  });

  it("detects rate_limit_exceeded", () => {
    expect(isRetryableError(1, "rate_limit_exceeded")).toBe(true);
  });

  it("detects structured JSON error", () => {
    const stderr = JSON.stringify({ error: { code: "RATE_LIMIT_EXCEEDED" } });
    expect(isRetryableError(1, stderr)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRetryableError(1, "file not found")).toBe(false);
  });

  describe("stdout JSONL fatal classification (exit 0)", () => {
    const turnFailed = (message: string) =>
      [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "turn.failed", error: { message } }),
      ].join("\n");

    it("retries a rate-limit turn.failed reported on stdout with exit 0", () => {
      expect(isRetryableError(0, "", turnFailed("rate limit exceeded"))).toBe(true);
    });

    it("retries a terminal top-level error with a rate-limit message on stdout", () => {
      const events = [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "error", message: "429 too many requests" }),
      ].join("\n");
      expect(isRetryableError(0, "", events)).toBe(true);
    });

    it("does NOT retry a non-rate-limit turn.failed (context length)", () => {
      expect(isRetryableError(0, "", turnFailed("context length exceeded"))).toBe(false);
    });

    it("does NOT retry a happy stdout stream", () => {
      const events = [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "ok" } }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n");
      expect(isRetryableError(0, "", events)).toBe(false);
    });

    it("does NOT retry a detail-less turn.failed (avoids false 'quota' match)", () => {
      const events = [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "turn.failed" }),
      ].join("\n");
      expect(isRetryableError(0, "", events)).toBe(false);
    });

    it("still honors stderr classification when stdout is also passed", () => {
      expect(isRetryableError(1, "rate limit exceeded", "some stdout")).toBe(true);
    });
  });
});

describe("checkErrorPatterns", () => {
  it("does not throw for exit code 0", () => {
    expect(() => checkErrorPatterns(0, "api key invalid")).not.toThrow();
  });

  it("throws for auth errors", () => {
    expect(() => checkErrorPatterns(1, "Invalid API key provided")).toThrow(
      /authentication error/i,
    );
  });

  it("throws for rate limit errors", () => {
    expect(() => checkErrorPatterns(1, "Rate limit exceeded")).toThrow(
      /rate limit/i,
    );
  });

  it("throws for generic non-zero exit when no stdout", () => {
    expect(() => checkErrorPatterns(1, "some other error")).toThrow(
      /exited with code 1/,
    );
  });

  it("does not throw for non-zero exit when stdout has content", () => {
    expect(() => checkErrorPatterns(1, "warning: something", "response text")).not.toThrow();
  });

  it("does not throw for non-zero exit with empty stderr", () => {
    expect(() => checkErrorPatterns(1, "")).not.toThrow();
  });
});

describe("toErrorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(toErrorMessage(new Error("test error"))).toBe("test error");
  });

  it("includes cause message for chained errors", () => {
    const cause = new Error("underlying failure");
    const outer = new Error("operation failed", { cause });
    expect(toErrorMessage(outer)).toBe("operation failed: underlying failure");
  });

  it("converts strings to string", () => {
    expect(toErrorMessage("raw string")).toBe("raw string");
  });

  it("extracts message from objects with message property", () => {
    expect(toErrorMessage({ message: "plain object error" })).toBe("plain object error");
  });

  it("converts objects without message to string", () => {
    expect(toErrorMessage({ code: 42 })).toBe("[object Object]");
  });

  it("handles null and undefined", () => {
    expect(toErrorMessage(null)).toBe("null");
    expect(toErrorMessage(undefined)).toBe("undefined");
  });
});
