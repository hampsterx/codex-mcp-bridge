import { describe, expect, it } from "vitest";
import {
  codexAnnotations,
  searchAnnotations,
  structuredAnnotations,
  listSessionsAnnotations,
  pingAnnotations,
} from "../../src/annotations.js";

const allAnnotations = {
  codex: codexAnnotations,
  search: searchAnnotations,
  structured: structuredAnnotations,
  listSessions: listSessionsAnnotations,
  ping: pingAnnotations,
};

const ANNOTATION_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

describe("tool annotations", () => {
  for (const [name, annotations] of Object.entries(allAnnotations)) {
    it(`${name} has all annotation hints`, () => {
      for (const key of ANNOTATION_KEYS) {
        expect(annotations).toHaveProperty(key);
        expect(typeof annotations[key]).toBe("boolean");
      }
    });

    it(`${name} has a title`, () => {
      expect(annotations.title).toBeDefined();
      expect(typeof annotations.title).toBe("string");
    });
  }

  it("codex is marked destructive and not read-only", () => {
    expect(codexAnnotations.readOnlyHint).toBe(false);
    expect(codexAnnotations.destructiveHint).toBe(true);
    expect(codexAnnotations.idempotentHint).toBe(false);
  });

  it("search is read-only and idempotent", () => {
    expect(searchAnnotations.readOnlyHint).toBe(true);
    expect(searchAnnotations.destructiveHint).toBe(false);
    expect(searchAnnotations.idempotentHint).toBe(true);
  });

  it("structured is read-only but not idempotent", () => {
    expect(structuredAnnotations.readOnlyHint).toBe(true);
    expect(structuredAnnotations.destructiveHint).toBe(false);
    expect(structuredAnnotations.idempotentHint).toBe(false);
  });

  it("listSessions is read-only, idempotent, and closed-world", () => {
    expect(listSessionsAnnotations.readOnlyHint).toBe(true);
    expect(listSessionsAnnotations.destructiveHint).toBe(false);
    expect(listSessionsAnnotations.idempotentHint).toBe(true);
    expect(listSessionsAnnotations.openWorldHint).toBe(false);
  });

  it("ping is read-only, idempotent, and closed-world", () => {
    expect(pingAnnotations.readOnlyHint).toBe(true);
    expect(pingAnnotations.destructiveHint).toBe(false);
    expect(pingAnnotations.idempotentHint).toBe(true);
    expect(pingAnnotations.openWorldHint).toBe(false);
  });
});
