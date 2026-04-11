import { describe, it, expect, beforeEach } from "vitest";
import {
  acquireSlot,
  releaseSlot,
  resetConcurrency,
  getActiveCount,
  getQueueDepth,
  getMaxConcurrent,
} from "../../src/utils/spawn.js";

describe("concurrency queue", () => {
  beforeEach(() => {
    resetConcurrency(2);
  });

  it("queues callers beyond maxConcurrent and grants on release", async () => {
    await acquireSlot();
    await acquireSlot();

    let granted = false;
    const waiting = acquireSlot(5_000).then(() => {
      granted = true;
    });

    await Promise.resolve();
    expect(getActiveCount()).toBe(2);
    expect(getQueueDepth()).toBe(1);
    expect(granted).toBe(false);

    releaseSlot();
    await waiting;

    expect(granted).toBe(true);
    expect(getActiveCount()).toBe(2);
    expect(getQueueDepth()).toBe(0);
  });

  it("releases the queue entry when acquireSlot times out (regression)", async () => {
    // Fill the pool.
    await acquireSlot();
    await acquireSlot();
    expect(getActiveCount()).toBe(2);

    // Queue one caller with a very short queue timeout.
    await expect(acquireSlot(20)).rejects.toThrow(/Concurrency queue timeout/);

    // The queue must be empty after the timeout — the prior bug left the
    // stale entry in waitQueue because findIndex compared against the
    // wrapper function instead of the queued entry itself.
    expect(getQueueDepth()).toBe(0);
    expect(getActiveCount()).toBe(2);

    // Release a real slot. Prior bug: releaseSlot() would shift the stale
    // entry and its wrapper would phantom-consume the freed slot
    // (decrement then increment), so activeCount would stay pinned at 2
    // and no real waiter could ever acquire again.
    releaseSlot();
    expect(getActiveCount()).toBe(1);
    expect(getQueueDepth()).toBe(0);

    // A fresh caller must still be able to acquire.
    await acquireSlot();
    expect(getActiveCount()).toBe(2);
  });

  it("does not leak slots after three consecutive queue timeouts", async () => {
    // This is the observed symptom from the handover: after several
    // cancelled/timed-out parallel calls the counter stayed pinned at
    // maxConcurrent with zero live subprocesses, because each subsequent
    // releaseSlot was phantom-consumed by a stale queue entry.
    await acquireSlot();
    await acquireSlot();

    for (let i = 0; i < 3; i++) {
      await expect(acquireSlot(10)).rejects.toThrow(/Concurrency queue timeout/);
    }

    expect(getActiveCount()).toBe(2);
    expect(getQueueDepth()).toBe(0);

    // Release both real slots and verify activeCount returns to zero.
    releaseSlot();
    releaseSlot();
    expect(getActiveCount()).toBe(0);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 2.5],
    ["NaN", Number.NaN],
  ])("rejects %s override and falls back to the default (%s)", (_label, value) => {
    resetConcurrency(value);
    expect(getMaxConcurrent()).toBe(3); // DEFAULT_MAX_CONCURRENT
  });

  it("restores the env-derived default when resetConcurrency() is called bare", () => {
    resetConcurrency(5);
    expect(getMaxConcurrent()).toBe(5);
    resetConcurrency();
    expect(getMaxConcurrent()).toBe(3); // back to DEFAULT_MAX_CONCURRENT
  });

  it("hands granted slot to the first real waiter, not a stale timed-out one", async () => {
    await acquireSlot();
    await acquireSlot();

    // First waiter will time out. 100ms gives ~80ms of slack over the
    // 20ms inter-waiter delay below, keeping the test robust under CI load.
    const timedOut = acquireSlot(100).catch((e) => e);

    // Let the first waiter register before the second one.
    await new Promise((r) => setTimeout(r, 20));

    // Second waiter with a comfortable timeout.
    let secondGranted = false;
    const second = acquireSlot(5_000).then(() => {
      secondGranted = true;
    });

    const err = await timedOut;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Concurrency queue timeout/);

    // Release one real slot. The slot must go to the real second waiter,
    // not to the stale first waiter's wrapper.
    releaseSlot();
    await second;

    expect(secondGranted).toBe(true);
    expect(getActiveCount()).toBe(2);
    expect(getQueueDepth()).toBe(0);
  });
});
