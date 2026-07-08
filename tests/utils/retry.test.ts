import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withModelFallback } from "../../src/utils/retry.js";
import type { SpawnResult } from "../../src/utils/spawn.js";

describe("withModelFallback", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["CODEX_FALLBACK_MODEL"];
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns result directly on success", async () => {
    const ok: SpawnResult = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    const result = await withModelFallback("o3", async () => ok, 60_000);
    expect(result.fallbackUsed).toBe(false);
    expect(result.result).toBe(ok);
  });

  it("retries with fallback on quota error", async () => {
    const quotaErr: SpawnResult = { stdout: "", stderr: "rate limit exceeded", exitCode: 1, timedOut: false };
    const ok: SpawnResult = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };

    let callCount = 0;
    const result = await withModelFallback(
      "gpt-5.3-codex",
      async (_model) => {
        callCount++;
        return callCount === 1 ? quotaErr : ok;
      },
      60_000,
    );

    expect(callCount).toBe(2);
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackModel).toBe("o3"); // default fallback
  });

  it("does not retry on timeout", async () => {
    const timedOut: SpawnResult = { stdout: "", stderr: "", exitCode: null, timedOut: true };
    let callCount = 0;
    const result = await withModelFallback(
      "o3",
      async () => { callCount++; return timedOut; },
      60_000,
    );
    expect(callCount).toBe(1);
    expect(result.fallbackUsed).toBe(false);
  });

  it("retries with fallback on a stdout JSONL rate-limit turn.failed (exit 0)", async () => {
    // Codex can report a rate-limited turn as a stdout event with exit 0 and
    // clean stderr; the stderr-only check would miss it (#31/#33).
    const rateLimited: SpawnResult = {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "turn.failed", error: { message: "rate limit exceeded" } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const ok: SpawnResult = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };

    let callCount = 0;
    const result = await withModelFallback(
      "gpt-5.3-codex",
      async () => {
        callCount++;
        return callCount === 1 ? rateLimited : ok;
      },
      60_000,
    );

    expect(callCount).toBe(2);
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackModel).toBe("o3");
    expect(result.result).toBe(ok);
  });

  it("does not retry a non-rate-limit stdout turn.failed (context length)", async () => {
    // A different model won't help; leave it for parseCodexOutput to throw.
    const contextErr: SpawnResult = {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "turn.failed", error: { message: "context length exceeded" } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    let callCount = 0;
    const result = await withModelFallback(
      "gpt-5.3-codex",
      async () => { callCount++; return contextErr; },
      60_000,
    );
    expect(callCount).toBe(1);
    expect(result.fallbackUsed).toBe(false);
    expect(result.result).toBe(contextErr);
  });

  it("retries on a terminal top-level stdout error with a rate-limit message", async () => {
    const terminalErr: SpawnResult = {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "error", message: "429 too many requests" }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const ok: SpawnResult = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    let callCount = 0;
    const result = await withModelFallback(
      "gpt-5.3-codex",
      async () => { callCount++; return callCount === 1 ? terminalErr : ok; },
      60_000,
    );
    expect(callCount).toBe(2);
    expect(result.fallbackUsed).toBe(true);
    expect(result.result).toBe(ok);
  });

  it("does not retry when fallback is disabled", async () => {
    process.env["CODEX_FALLBACK_MODEL"] = "none";
    const quotaErr: SpawnResult = { stdout: "", stderr: "quota exceeded", exitCode: 1, timedOut: false };
    let callCount = 0;
    const result = await withModelFallback(
      "o3",
      async () => { callCount++; return quotaErr; },
      60_000,
    );
    expect(callCount).toBe(1);
    expect(result.fallbackUsed).toBe(false);
  });
});
