import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executePing } from "../../src/tools/ping.js";
import {
  acquireSlot,
  releaseSlot,
  resetConcurrency,
  getMaxConcurrent,
} from "../../src/utils/spawn.js";

describe("executePing concurrency diagnostics", () => {
  beforeEach(() => {
    resetConcurrency(2);
  });

  afterEach(() => {
    resetConcurrency();
  });

  it("reports maxConcurrent, activeCount, and queueDepth at rest", async () => {
    const result = await executePing();
    expect(result.maxConcurrent).toBe(2);
    expect(result.activeCount).toBe(0);
    expect(result.queueDepth).toBe(0);
  });

  it("reflects live activeCount when slots are held", async () => {
    await acquireSlot();
    await acquireSlot();

    const result = await executePing();
    expect(result.activeCount).toBe(2);
    expect(result.queueDepth).toBe(0);

    releaseSlot();
    releaseSlot();
  });

  it("reflects queueDepth when callers are waiting", async () => {
    await acquireSlot();
    await acquireSlot();

    // Queue a waiter. Don't await — it will block until released.
    const waiting = acquireSlot(5_000);

    const result = await executePing();
    expect(result.activeCount).toBe(2);
    expect(result.queueDepth).toBe(1);

    releaseSlot(); // Grants slot to the waiter.
    await waiting;
    releaseSlot();
    releaseSlot();
  });

  it("returns the same maxConcurrent value as getMaxConcurrent", async () => {
    const result = await executePing();
    expect(result.maxConcurrent).toBe(getMaxConcurrent());
  });
});

describe("executePing supportedModels", () => {
  it("includes supportedModels array in result", async () => {
    const result = await executePing();
    expect(Array.isArray(result.supportedModels)).toBe(true);
    expect(result.supportedModels.length).toBeGreaterThanOrEqual(3);
  });

  it("each model has id, tier, description, and isDefault", async () => {
    const result = await executePing();
    for (const m of result.supportedModels) {
      expect(typeof m.id).toBe("string");
      expect(["fast", "standard", "powerful"]).toContain(m.tier);
      expect(typeof m.description).toBe("string");
      expect(typeof m.isDefault).toBe("boolean");
    }
  });
});
