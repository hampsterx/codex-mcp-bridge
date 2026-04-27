import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReviewStream } from "../../src/utils/review-events.js";

function fixture(name: string): string {
  return readFileSync(
    path.resolve(import.meta.dirname, `../fixtures/review/${name}.jsonl`),
    "utf8",
  );
}

describe("parseReviewStream", () => {
  it("extracts final text and metadata from uncommitted review JSONL", () => {
    const result = parseReviewStream(fixture("uncommitted"));

    expect(result.finalText).toContain("[P1]");
    expect(result.meta.threadId).toBe("019d5a9f-1234-5678-abcd-0123456789ab");
    expect(result.meta.turnsStarted).toBe(1);
    expect(result.meta.turnsCompleted).toBe(1);
    expect(result.meta.eventCounts["item.completed"]).toBe(2);
    expect(result.meta.commands).toEqual([
      {
        id: "cmd_1",
        command: ["git", "diff", "--stat"],
        aggregatedOutput: "src/app.ts | 2 +-",
        exitCode: 0,
        status: "completed",
      },
    ]);
  });

  it("redacts secrets in command output", () => {
    const result = parseReviewStream(fixture("base"));

    expect(result.finalText).toBe("No blocking findings.");
    expect(result.meta.commands[0]?.aggregatedOutput).toBe("[REDACTED]");
    expect(result.meta.reasoningSummaries).toEqual([
      "Checked changed files",
      "Focused on production failures",
    ]);
  });

  it("supports alternate command field names", () => {
    const result = parseReviewStream(fixture("commit"));

    expect(result.finalText).toContain("[P2]");
    expect(result.meta.commands[0]?.command).toEqual(["git", "show", "abc123"]);
    expect(result.meta.commands[0]?.aggregatedOutput).toBe("commit abc123");
    expect(result.meta.commands[0]?.exitCode).toBe(0);
  });

  it("returns null final text for an empty stream", () => {
    const result = parseReviewStream(fixture("empty"));

    expect(result.finalText).toBeNull();
    expect(result.meta.parseFailures).toBe(0);
    expect(result.meta.eventCounts).toEqual({});
    expect(result.meta.commands).toEqual([]);
  });

  it("counts parse failures while preserving valid events", () => {
    const result = parseReviewStream(fixture("garbage"));

    expect(result.finalText).toBe("Recovered final message.");
    expect(result.meta.parseFailures).toBe(2);
    expect(result.meta.eventCounts["unknown.future"]).toBe(1);
    expect(result.meta.commands[0]?.command).toBe("echo [REDACTED]");
    expect(result.meta.commands[0]?.aggregatedOutput).toBe("[REDACTED]");
  });

  it("recovers text from plain output when JSONL parsing fails", () => {
    const result = parseReviewStream("plain review output\nwith details");

    expect(result.finalText).toBe("plain review output\nwith details");
    expect(result.meta.parseFailures).toBe(2);
  });

  it("recovers text from single-object JSON output", () => {
    const result = parseReviewStream(JSON.stringify({ response: "JSON review output" }));

    expect(result.finalText).toBe("JSON review output");
    expect(result.meta.parseFailures).toBe(0);
  });
});
