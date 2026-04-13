/**
 * Session storage for Codex conversation resume.
 *
 * Codex CLI supports multi-turn conversations via `codex exec resume <conversation-id>`.
 * This module stores conversation IDs extracted from CLI output (JSONL events or stderr).
 */

/** Validate a session/conversation ID. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_SESSION_ID_LENGTH = 256;

export function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_PATTERN.test(id);
}

export interface SessionEntry {
  conversationId: string;
  model?: string;
  createdAt: number;
  lastUsedAt: number;
  turnCount: number;
}

export interface SessionStorage {
  get(sessionId: string): SessionEntry | undefined;
  set(sessionId: string, entry: SessionEntry): void;
  delete(sessionId: string): void;
  list(): Array<{ sessionId: string; entry: SessionEntry }>;
}

/** Default TTL: 24 hours. */
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

/** Default max sessions. */
const DEFAULT_MAX_SESSIONS = 100;

/**
 * In-memory session storage with TTL and max capacity.
 * Entries are evicted LRU-style when capacity is reached.
 */
export class InMemorySessionStorage implements SessionStorage {
  private store = new Map<string, SessionEntry>();
  private ttl: number;
  private maxSessions: number;

  constructor(ttl = DEFAULT_TTL, maxSessions = DEFAULT_MAX_SESSIONS) {
    this.ttl = ttl;
    this.maxSessions = maxSessions;
  }

  /**
   * Retrieve a session by ID.
   *
   * Side effect: updates `lastUsedAt` on the stored entry, which affects
   * LRU eviction ordering. Returns a shallow copy so callers cannot
   * mutate the stored entry directly.
   */
  get(sessionId: string): SessionEntry | undefined {
    this.evictExpired();
    const entry = this.store.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      return { ...entry };
    }
    return undefined;
  }

  set(sessionId: string, entry: SessionEntry): void {
    this.evictExpired();
    // Evict oldest if at capacity
    if (this.store.size >= this.maxSessions && !this.store.has(sessionId)) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, val] of this.store) {
        if (val.lastUsedAt < oldestTime) {
          oldestTime = val.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(sessionId, { ...entry });
  }

  delete(sessionId: string): void {
    this.store.delete(sessionId);
  }

  list(): Array<{ sessionId: string; entry: SessionEntry }> {
    this.evictExpired();
    return Array.from(this.store.entries()).map(([sessionId, entry]) => ({
      sessionId,
      entry: { ...entry },
    }));
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.lastUsedAt > this.ttl) {
        this.store.delete(key);
      }
    }
  }
}

/** Global session store instance. */
export const sessionStore = new InMemorySessionStorage();
