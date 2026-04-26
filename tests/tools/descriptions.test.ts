import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Extract tool descriptions from src/index.ts.
 *
 * We read the source to validate description content without
 * starting the MCP server. The descriptions are template literals
 * in registerTool() calls.
 */
const indexSource = readFileSync(
  path.resolve(import.meta.dirname, "../../src/index.ts"),
  "utf8",
);

/** Max description size in bytes (plan: 2KB per tool). */
const MAX_DESCRIPTION_SIZE = 2048;

/**
 * Extract the description string for a given tool name from the source.
 * Handles both single-line strings and template literals.
 */
function extractDescription(toolName: string): string {
  // Isolate the registerTool block for this tool so the description
  // regex doesn't drift into the next tool's definition.
  const blockStart = indexSource.search(
    new RegExp(`registerTool\\(\\s*"${toolName}"`),
  );
  if (blockStart < 0) {
    throw new Error(`Could not locate registerTool for: ${toolName}`);
  }
  const rest = indexSource.slice(blockStart + 1);
  const nextStart = rest.search(/registerTool\(\s*"/);
  const block = nextStart >= 0
    ? indexSource.slice(blockStart, blockStart + 1 + nextStart)
    : indexSource.slice(blockStart);

  const patterns = [
    // Template literal (backtick)
    /description:\s*`([\s\S]*?)`/,
    // Regular string
    /description:\s*"([^"]*)"/,
  ];

  for (const pattern of patterns) {
    const match = block.match(pattern);
    if (match?.[1]) return match[1];
  }
  throw new Error(`Could not extract description for tool: ${toolName}`);
}

describe("tool descriptions", () => {
  const tools = ["codex", "search", "structured", "listSessions", "ping"];

  for (const tool of tools) {
    it(`${tool} description exists and is non-empty`, () => {
      const desc = extractDescription(tool);
      expect(desc.length).toBeGreaterThan(0);
    });

    it(`${tool} description is under ${MAX_DESCRIPTION_SIZE} bytes`, () => {
      const desc = extractDescription(tool);
      expect(Buffer.byteLength(desc, "utf8")).toBeLessThanOrEqual(
        MAX_DESCRIPTION_SIZE,
      );
    });
  }

  // Rich description content checks for the three rewritten tools

  describe("codex", () => {
    const desc = extractDescription("codex");

    it("mentions capabilities", () => {
      expect(desc).toContain("Capabilities:");
      expect(desc).toContain("code generation");
      expect(desc).toContain("multi-turn conversations");
    });

    it("includes prompt tips", () => {
      expect(desc).toContain("Tips:");
      expect(desc).toContain("workingDirectory");
      expect(desc).toContain("sessionId");
      expect(desc).toContain("reasoningEffort");
    });

    it("mentions project context", () => {
      expect(desc).toContain("AGENTS.md");
    });
  });

  describe("listSessions", () => {
    const desc = extractDescription("listSessions");

    it("describes session listing purpose", () => {
      expect(desc).toContain("session");
      expect(desc).toContain("orchestration");
    });

    it("clarifies no sensitive data", () => {
      expect(desc).toMatch(/no prompts|metadata/i);
    });
  });

  describe("search", () => {
    const desc = extractDescription("search");

    it("describes use cases", () => {
      expect(desc).toContain("documentation");
      expect(desc).toContain("research");
    });

    it("mentions source URLs", () => {
      expect(desc).toContain("source URLs");
    });

    it("includes prompt tips", () => {
      expect(desc).toContain("Tips:");
      expect(desc).toContain("maxResponseLength");
    });
  });
});
