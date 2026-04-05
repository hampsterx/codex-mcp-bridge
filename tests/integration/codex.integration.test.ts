import { describe, expect, it } from "vitest";

const runIntegration = process.env["CODEX_INTEGRATION"] === "1";
const maybeIt = runIntegration ? it : it.skip;

describe("codex integration", () => {
  maybeIt("is enabled explicitly via CODEX_INTEGRATION=1", () => {
    expect(runIntegration).toBe(true);
  });
});
