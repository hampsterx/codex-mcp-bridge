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

      it("preserves placeholder substitution after the additions", () => {
        // No `{{...}}` token from the prompt template should leak through.
        // The diff payload itself can legitimately contain double braces, so
        // we scan only what the loader emits before the diff body.
        const beforeDiff = prompt.split("DUMMY DIFF")[0] ?? prompt;
        expect(beforeDiff).not.toMatch(/\{\{[A-Z_]+\}\}/);
      });
    });
  }
});
