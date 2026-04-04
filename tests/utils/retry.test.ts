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
