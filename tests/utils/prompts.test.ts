import { describe, it, expect, vi, beforeEach } from "vitest";

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
}));

import { loadPrompt, buildLengthLimit, appendLengthLimit } from "../../src/utils/prompts.js";

beforeEach(() => {
  readFileSyncMock.mockReset();
});

describe("loadPrompt", () => {
  it("replaces placeholders with provided values", () => {
    readFileSyncMock.mockReturnValue("Hello {{NAME}}, you have {{COUNT}} items.");
    const result = loadPrompt("template.md", { NAME: "Alice", COUNT: "3" });
    expect(result).toBe("Hello Alice, you have 3 items.");
  });

  it("returns template unchanged when vars is empty", () => {
    readFileSyncMock.mockReturnValue("No {{PLACEHOLDERS}} here.");
    const result = loadPrompt("template.md", {});
    expect(result).toBe("No {{PLACEHOLDERS}} here.");
  });

  it("leaves unknown placeholders unchanged", () => {
    readFileSyncMock.mockReturnValue("{{KNOWN}} and {{UNKNOWN}}");
    const result = loadPrompt("template.md", { KNOWN: "replaced" });
    expect(result).toBe("replaced and {{UNKNOWN}}");
  });

  it("handles keys with regex-special characters", () => {
    readFileSyncMock.mockReturnValue("Value: {{KEY.NAME+1}}");
    const result = loadPrompt("template.md", { "KEY.NAME+1": "safe" });
    expect(result).toBe("Value: safe");
  });

  it("uses single-pass replacement (user text with placeholder syntax is not mutated)", () => {
    readFileSyncMock.mockReturnValue("{{FIRST}} then {{SECOND}}");
    // FIRST's value contains something that looks like a placeholder for SECOND
    const result = loadPrompt("template.md", { FIRST: "{{SECOND}}", SECOND: "real" });
    expect(result).toBe("{{SECOND}} then real");
  });

  it("strips path traversal via basename", () => {
    readFileSyncMock.mockReturnValue("content");
    loadPrompt("../../etc/passwd", {});
    // readFileSync should be called with just "passwd" as the filename component
    const calledPath = readFileSyncMock.mock.calls[0]![0] as string;
    expect(calledPath).not.toContain("..");
    expect(calledPath.endsWith("passwd")).toBe(true);
  });
});

describe("buildLengthLimit", () => {
  it("returns instruction for positive word count", () => {
    expect(buildLengthLimit(500)).toBe("Keep your response under 500 words.");
  });

  it("returns empty string for zero", () => {
    expect(buildLengthLimit(0)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(buildLengthLimit(undefined)).toBe("");
  });

  it("returns empty string for negative values", () => {
    expect(buildLengthLimit(-10)).toBe("");
  });
});

describe("appendLengthLimit", () => {
  it("appends limit instruction to prompt", () => {
    const result = appendLengthLimit("Review this code.", 200);
    expect(result).toBe("Review this code.\n\nKeep your response under 200 words.");
  });

  it("returns prompt unchanged when no limit", () => {
    expect(appendLengthLimit("Review this code.")).toBe("Review this code.");
  });

  it("returns prompt unchanged when limit is zero", () => {
    expect(appendLengthLimit("Review this code.", 0)).toBe("Review this code.");
  });
});
