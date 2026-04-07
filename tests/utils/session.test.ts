import { afterEach, describe, expect, it } from "vitest";
import {
  InMemorySessionStorage,
  isValidSessionId,
  sessionStore,
} from "../../src/utils/session.js";

describe("isValidSessionId", () => {
  it("accepts alphanumeric with hyphens and underscores", () => {
    expect(isValidSessionId("codex-123")).toBe(true);
    expect(isValidSessionId("session_abc_456")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidSessionId("")).toBe(false);
  });

  it("rejects strings with special characters", () => {
    expect(isValidSessionId("session/../hack")).toBe(false);
    expect(isValidSessionId("a b")).toBe(false);
  });

  it("rejects strings exceeding max length", () => {
    expect(isValidSessionId("a".repeat(257))).toBe(false);
    expect(isValidSessionId("a".repeat(256))).toBe(true);
  });
});

describe("InMemorySessionStorage", () => {
  it("stores and retrieves sessions", () => {
    const store = new InMemorySessionStorage();
    store.set("s1", {
      conversationId: "conv1",
      model: "o3",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      turnCount: 1,
    });
    const entry = store.get("s1");
    expect(entry).toBeDefined();
    expect(entry!.conversationId).toBe("conv1");
  });

  it("returns undefined for missing sessions", () => {
    const store = new InMemorySessionStorage();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("does not increment turnCount on get (read-only lookup)", () => {
    const store = new InMemorySessionStorage();
    store.set("s1", {
      conversationId: "conv1",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      turnCount: 1,
    });
    store.get("s1");
    store.get("s1");
    const entry = store.get("s1");
    expect(entry!.turnCount).toBe(1); // unchanged by get()
  });

  it("deletes sessions", () => {
    const store = new InMemorySessionStorage();
    store.set("s1", {
      conversationId: "conv1",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      turnCount: 1,
    });
    store.delete("s1");
    expect(store.get("s1")).toBeUndefined();
  });

  it("lists all active sessions", () => {
    const store = new InMemorySessionStorage();
    const now = Date.now();
    store.set("s1", {
      conversationId: "conv1",
      model: "o3",
      createdAt: now - 1000,
      lastUsedAt: now,
      turnCount: 1,
    });
    store.set("s2", {
      conversationId: "conv2",
      model: "gpt-4.1",
      createdAt: now - 500,
      lastUsedAt: now,
      turnCount: 3,
    });
    const sessions = store.list();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("returns empty list when no sessions exist", () => {
    const store = new InMemorySessionStorage();
    expect(store.list()).toEqual([]);
  });

  it("evicts expired sessions from list", () => {
    const store = new InMemorySessionStorage(100); // 100ms TTL
    store.set("s1", {
      conversationId: "conv1",
      createdAt: Date.now(),
      lastUsedAt: Date.now() - 200, // already expired
      turnCount: 1,
    });
    expect(store.list()).toEqual([]);
  });

  it("evicts oldest session when at max capacity", () => {
    const now = Date.now();
    const store = new InMemorySessionStorage(undefined, 2); // max 2
    store.set("s1", {
      conversationId: "conv1",
      createdAt: now,
      lastUsedAt: now - 2000,
      turnCount: 1,
    });
    store.set("s2", {
      conversationId: "conv2",
      createdAt: now,
      lastUsedAt: now - 1000,
      turnCount: 1,
    });
    store.set("s3", {
      conversationId: "conv3",
      createdAt: now,
      lastUsedAt: now,
      turnCount: 1,
    });
    const sessions = store.list();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["s2", "s3"]);
  });

  it("list output includes all session fields", () => {
    const store = new InMemorySessionStorage();
    const now = Date.now();
    store.set("s1", {
      conversationId: "conv1",
      model: "o3",
      createdAt: now,
      lastUsedAt: now,
      turnCount: 5,
    });
    const [session] = store.list();
    expect(session!.entry.conversationId).toBe("conv1");
    expect(session!.entry.model).toBe("o3");
    expect(session!.entry.createdAt).toBe(now);
    expect(session!.entry.turnCount).toBe(5);
  });
});

describe("global sessionStore", () => {
  afterEach(() => {
    for (const { sessionId } of sessionStore.list()) {
      sessionStore.delete(sessionId);
    }
  });

  it("is an InMemorySessionStorage instance", () => {
    expect(sessionStore).toBeInstanceOf(InMemorySessionStorage);
  });
});
