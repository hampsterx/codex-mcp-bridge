import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgenticPrompt,
  buildFocusedPrompt,
  buildQuickPrompt,
} from "../../src/tools/review.js";

const SILENT_FAILURE_HEADER = "### Silent-Failure Checks";
const FINAL_PASS_HEADER = "### Final-pass questions";
const COUNTEREXAMPLE_MARKER = "Not a finding (counterexample)";

const variants: Array<[string, () => string]> = [
  ["agentic (no serena)", () => buildAgenticPrompt("git diff HEAD", undefined, undefined, false)],
  ["agentic (with serena)", () => buildAgenticPrompt("git diff HEAD", undefined, undefined, true)],
  ["focused", () => buildFocusedPrompt("DUMMY DIFF")],
  ["quick", () => buildQuickPrompt("DUMMY DIFF")],
];

describe("review prompt silent-failure markers", () => {
  for (const [name, build] of variants) {
    describe(name, () => {
      const prompt = build();

      it("includes the silent-failure checklist header", () => {
        expect(prompt).toContain(SILENT_FAILURE_HEADER);
      });

      it("includes the final-pass question header", () => {
        expect(prompt).toContain(FINAL_PASS_HEADER);
      });

      it("includes the negative counterexample", () => {
        expect(prompt).toContain(COUNTEREXAMPLE_MARKER);
      });

      it("does not leak any unsubstituted {{KEY}} placeholders", () => {
        // For focused/quick variants, the diff body comes after a "DUMMY DIFF"
        // marker; everything before it is template-emitted text. For agentic
        // variants the marker is absent, so split returns the whole prompt as
        // element 0 and we scan the entire output. Either way, no
        // `{{ALL_CAPS}}` placeholder should survive substitution.
        const beforeDiff = prompt.split("DUMMY DIFF")[0];
        expect(beforeDiff).not.toMatch(/\{\{[A-Z_]+\}\}/);
      });
    });
  }
});

describe("review prompt silent-failure block parity", () => {
  // The silent-failure checklist + exemplars + final-pass question is
  // duplicated across all four prompt variants because `loadPrompt` only does
  // flat `{{KEY}}` substitution and `src/` is out of scope for the change that
  // introduced this block. This test guards against drift between copies.
  const promptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../prompts");
  const blockStart = "### Silent-Failure Checks";
  const blockEnd = 'If the answer to any is "yes"';

  function extractBlock(filename: string): string {
    const contents = readFileSync(resolve(promptsDir, filename), "utf8");
    const startIdx = contents.indexOf(blockStart);
    const endIdx = contents.indexOf(blockEnd, startIdx);
    if (startIdx === -1 || endIdx === -1) {
      throw new Error(`Silent-failure block markers not found in ${filename}`);
    }
    const endOfClosingLine = contents.indexOf("\n", endIdx);
    return contents.slice(startIdx, endOfClosingLine === -1 ? contents.length : endOfClosingLine);
  }

  const reference = extractBlock("review-agentic.md");

  for (const filename of [
    "review-agentic-with-serena.md",
    "review-focused.md",
    "review-quick.md",
  ]) {
    it(`${filename} silent-failure block matches review-agentic.md byte-for-byte`, () => {
      expect(extractBlock(filename)).toBe(reference);
    });
  }
});
