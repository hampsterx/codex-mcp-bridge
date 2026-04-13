import { describe, it, expect } from "vitest";
import { isImageFile, assemblePrompt, readFiles, parseFileSpec } from "../../src/utils/files.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("isImageFile", () => {
  it("detects png", () => expect(isImageFile("photo.png")).toBe(true));
  it("detects jpg", () => expect(isImageFile("photo.jpg")).toBe(true));
  it("detects jpeg", () => expect(isImageFile("photo.JPEG")).toBe(true));
  it("detects gif", () => expect(isImageFile("anim.gif")).toBe(true));
  it("detects webp", () => expect(isImageFile("image.webp")).toBe(true));
  it("rejects txt", () => expect(isImageFile("file.txt")).toBe(false));
  it("rejects ts", () => expect(isImageFile("src/index.ts")).toBe(false));
  it("detects image with line range suffix", () => expect(isImageFile("photo.png:1-10")).toBe(true));
  it("rejects text with line range suffix", () => expect(isImageFile("file.txt:1-10")).toBe(false));
});

describe("parseFileSpec", () => {
  it("returns full path when no range", () => {
    expect(parseFileSpec("src/lib.rs")).toEqual({ path: "src/lib.rs" });
  });

  it("parses start-end range", () => {
    expect(parseFileSpec("src/lib.rs:900-950")).toEqual({
      path: "src/lib.rs",
      startLine: 900,
      endLine: 950,
    });
  });

  it("handles single-line range", () => {
    expect(parseFileSpec("foo.ts:42-42")).toEqual({
      path: "foo.ts",
      startLine: 42,
      endLine: 42,
    });
  });

  it("handles Windows drive letter paths", () => {
    expect(parseFileSpec("C:\\src\\file.ts:10-20")).toEqual({
      path: "C:\\src\\file.ts",
      startLine: 10,
      endLine: 20,
    });
  });

  it("treats colon without range pattern as part of path", () => {
    // e.g. "C:\foo" with no digits-digits suffix
    expect(parseFileSpec("C:\\foo\\bar.ts")).toEqual({ path: "C:\\foo\\bar.ts" });
  });

  it("throws for start < 1", () => {
    expect(() => parseFileSpec("file.ts:0-10")).toThrow(/start must be >= 1/);
  });

  it("throws for start > end", () => {
    expect(() => parseFileSpec("file.ts:50-10")).toThrow(/start \(50\) > end \(10\)/);
  });
});

describe("assemblePrompt", () => {
  it("returns prompt alone when no files", () => {
    expect(assemblePrompt("Hello", [])).toBe("Hello");
  });

  it("includes file contents", () => {
    const result = assemblePrompt("Review this:", [
      { path: "foo.ts", content: "const x = 1;" },
    ]);
    expect(result).toContain("foo.ts");
    expect(result).toContain("const x = 1;");
  });

  it("marks skipped files", () => {
    const result = assemblePrompt("Review:", [
      { path: "big.bin", content: "", skipped: "too large" },
    ]);
    expect(result).toContain("[SKIPPED: too large]");
  });

  it("uses label when present", () => {
    const result = assemblePrompt("Review:", [
      { path: "src/lib.rs:10-20", content: "fn main() {}", label: "src/lib.rs:10-20 (11 of 100 lines)" },
    ]);
    expect(result).toContain("--- src/lib.rs:10-20 (11 of 100 lines) ---");
  });
});

describe("readFiles", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-files-test-"));
  writeFileSync(join(tempDir, "a.txt"), "content-a");
  writeFileSync(join(tempDir, "b.txt"), "content-b");

  // 10-line file for region tests (no trailing newline)
  const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
  writeFileSync(join(tempDir, "lines.txt"), lines.join("\n"));

  // 5-line file with trailing newline (typical source file)
  writeFileSync(join(tempDir, "trailing.txt"), "a\nb\nc\nd\ne\n");

  it("reads files within root", async () => {
    const results = await readFiles(["a.txt", "b.txt"], tempDir);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("content-a");
    expect(results[1].content).toBe("content-b");
  });

  it("throws for too many files", async () => {
    const files = Array.from({ length: 21 }, (_, i) => `file${i}.txt`);
    await expect(readFiles(files, tempDir)).rejects.toThrow(/too many files/i);
  });

  it("reads a line range from a file", async () => {
    const results = await readFiles(["lines.txt:3-5"], tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("line3\nline4\nline5");
    expect(results[0].label).toContain("3-5");
    expect(results[0].label).toContain("of 10 lines");
  });

  it("clamps end line to file length", async () => {
    const results = await readFiles(["lines.txt:8-100"], tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("line8\nline9\nline10");
    expect(results[0].label).toContain("8-10");
  });

  it("reads a single line", async () => {
    const results = await readFiles(["lines.txt:1-1"], tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("line1");
  });

  it("reads full file without range specifier", async () => {
    const results = await readFiles(["lines.txt"], tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe(lines.join("\n"));
    expect(results[0].label).toBeUndefined();
  });

  it("preserves original specifier as path", async () => {
    const results = await readFiles(["lines.txt:2-4"], tempDir);
    expect(results[0].path).toBe("lines.txt:2-4");
  });

  it("returns empty content when start is past EOF", async () => {
    const results = await readFiles(["lines.txt:20-30"], tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("");
    expect(results[0].label).toContain("requested range past 10-line file");
  });

  it("counts lines correctly for files with trailing newline", async () => {
    const results = await readFiles(["trailing.txt:1-5"], tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("a\nb\nc\nd\ne");
    expect(results[0].label).toContain("5 of 5 lines");
  });

  it("does not over-count lines with trailing newline", async () => {
    const results = await readFiles(["trailing.txt:5-10"], tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("e");
    expect(results[0].label).toContain("1 of 5 lines");
  });
});
