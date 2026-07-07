import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";

const { spawnCodexMock } = vi.hoisted(() => ({
  spawnCodexMock: vi.fn<(options: SpawnOptions) => Promise<SpawnResult>>(),
}));

vi.mock("../../src/utils/spawn.js", () => ({
  spawnCodex: spawnCodexMock,
  HARD_TIMEOUT_CAP: 1_800_000,
}));

import { buildReviewArgs, executeReview } from "../../src/tools/review.js";

function fixture(name: string): string {
  return readFileSync(
    path.resolve(import.meta.dirname, `../fixtures/review/${name}.jsonl`),
    "utf8",
  );
}

const origFallbackModel = process.env["CODEX_FALLBACK_MODEL"];
const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
});

describe("buildReviewArgs", () => {
  it("builds uncommitted review args with hardened defaults", () => {
    expect(buildReviewArgs({
      mode: "uncommitted",
      outputFile: "/tmp/review.txt",
      model: "o3",
    })).toEqual([
      "exec",
      "review",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--full-auto",
      "-o",
      "/tmp/review.txt",
      "--uncommitted",
      "--model",
      "o3",
    ]);
  });

  it("uses native base and commit flag shapes", () => {
    expect(buildReviewArgs({
      mode: "base",
      base: "main",
      title: "Review title",
      outputFile: "/tmp/review.txt",
    })).toEqual([
      "exec",
      "review",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--full-auto",
      "-o",
      "/tmp/review.txt",
      "--base",
      "main",
      "--title",
      "Review title",
    ]);

    expect(buildReviewArgs({
      mode: "commit",
      commit: "abc123",
      outputFile: "/tmp/review.txt",
    })).toContain("--commit");
  });

  it("escapes output file path on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    const args = buildReviewArgs({
      mode: "uncommitted",
      outputFile: 'C:\\Temp\\100% "review".txt',
    });

    expect(args[args.indexOf("-o") + 1]).toBe('C:\\Temp\\100%% ""review"".txt');
  });
});

describe("executeReview", () => {
  let workingDirectory: string;

  beforeEach(async () => {
    spawnCodexMock.mockReset();
    process.env["CODEX_FALLBACK_MODEL"] = "none";
    workingDirectory = await mkdtemp(path.join(os.tmpdir(), "review-tool-test-"));
  });

  afterEach(async () => {
    if (origFallbackModel === undefined) delete process.env["CODEX_FALLBACK_MODEL"];
    else process.env["CODEX_FALLBACK_MODEL"] = origFallbackModel;
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("requires workingDirectory", async () => {
    await expect(executeReview({ mode: "uncommitted" })).rejects.toThrow("workingDirectory is required");
  });

  it("requires base for base mode", async () => {
    await expect(executeReview({
      mode: "base",
      workingDirectory,
    })).rejects.toThrow('base is required when mode is "base"');
  });

  it("requires commit for commit mode", async () => {
    await expect(executeReview({
      mode: "commit",
      workingDirectory,
    })).rejects.toThrow('commit is required when mode is "commit"');
  });

  it("rejects invalid modes defensively", async () => {
    await expect(executeReview({
      mode: "everything" as "uncommitted",
      workingDirectory,
    })).rejects.toThrow("Invalid review mode");
  });

  it("returns output-last-message text byte-for-byte when available", async () => {
    const exactOutput = "Final text from -o\nwith trailing newline\n";
    spawnCodexMock.mockImplementation(async ({ args }) => {
      const outputIndex = args.indexOf("-o");
      expect(outputIndex).toBeGreaterThan(-1);
      await writeFile(args[outputIndex + 1]!, exactOutput, "utf8");
      return {
        stdout: fixture("uncommitted"),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await executeReview({
      mode: "uncommitted",
      workingDirectory,
      model: "o3",
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.cwd).toBe(workingDirectory);
    expect(call.timeout).toBe(180_000);
    expect(call.args).toContain("--uncommitted");
    expect(result.response).toBe(exactOutput);
    expect(result.threadId).toBe("019d5a9f-1234-5678-abcd-0123456789ab");
    expect(result.meta.commands.length).toBe(1);
  });

  it("falls back to parsed final text when the output file is absent", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: fixture("commit"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeReview({
      mode: "commit",
      commit: "abc123",
      workingDirectory,
      timeout: 5000,
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args).toContain("--commit");
    expect(call.args).toContain("abc123");
    expect(call.timeout).toBe(5000);
    expect(result.response).toContain("[P2]");
    expect(result.mode).toBe("commit");
    expect(result.timedOut).toBe(false);
  });

  it("falls back to stderr review events when stdout has no review output", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "",
      stderr: fixture("uncommitted"),
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeReview({
      mode: "uncommitted",
      workingDirectory,
    });

    expect(result.response).toContain("[P1]");
    expect(result.threadId).toBe("019d5a9f-1234-5678-abcd-0123456789ab");
  });

  it("throws when the output file exists but cannot be read", async () => {
    if (process.platform === "win32") return;

    spawnCodexMock.mockImplementation(async ({ args }) => {
      const outputIndex = args.indexOf("-o");
      expect(outputIndex).toBeGreaterThan(-1);
      const outputFile = args[outputIndex + 1]!;
      await writeFile(outputFile, "unreadable", "utf8");
      await chmod(outputFile, 0o000);
      return {
        stdout: fixture("uncommitted"),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });

    await expect(executeReview({
      mode: "uncommitted",
      workingDirectory,
    })).rejects.toThrow();
  });


  it("surfaces a fatal turn.failed event as an error", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "turn.failed", error: { message: "rate limit exceeded" } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    await expect(executeReview({
      mode: "uncommitted",
      workingDirectory,
    })).rejects.toThrow("rate limit exceeded");
  });

  it("recovers a review that emits a transient top-level error (reconnect) then completes", async () => {
    // A top-level `error` event is a transient stream retry, not a failure. The
    // review must still return its body rather than aborting.
    spawnCodexMock.mockResolvedValue({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (Idle timeout waiting for SSE)" }),
        JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: "Recovered review body" } }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeReview({
      mode: "uncommitted",
      workingDirectory,
    });

    expect(result.response).toBe("Recovered review body");
  });

  it("surfaces a fatal stderr event even when stdout carried progress and an output file exists", async () => {
    // stdout has only progress events, stderr carries the real failure, and the
    // -o output file has partial text. Without the fatal-merge this returns the
    // partial text as a successful review.
    spawnCodexMock.mockImplementation(async ({ args }) => {
      const outputIndex = args.indexOf("-o");
      await writeFile(args[outputIndex + 1]!, "partial review text before failure", "utf8");
      return {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "t1" }),
          JSON.stringify({ type: "turn.started" }),
        ].join("\n"),
        stderr: JSON.stringify({ type: "turn.failed", error: { message: "context length exceeded" } }),
        exitCode: 0,
        timedOut: false,
      };
    });

    await expect(executeReview({
      mode: "uncommitted",
      workingDirectory,
    })).rejects.toThrow("context length exceeded");
  });

  it("redacts command metadata from parsed events", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: fixture("garbage"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeReview({
      mode: "base",
      base: "main",
      workingDirectory,
    });

    expect(result.meta.commands[0]?.command).toBe("echo [REDACTED]");
    expect(result.meta.commands[0]?.aggregatedOutput).toBe("[REDACTED]");
    expect(result.meta.parseFailures).toBe(2);
  });

  it("surfaces partial parsed output on timeout", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: fixture("uncommitted"),
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeReview({
      mode: "uncommitted",
      workingDirectory,
      timeout: 5000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("[P1]");
  });

  it("throws when review exits non-zero without stderr", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });

    await expect(executeReview({
      mode: "uncommitted",
      workingDirectory,
    })).rejects.toThrow("Codex review exited with code 1");
  });

  it("throws when JSONL events contain no final review message", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "019d5a9f-1234-5678-abcd-0123456789ab" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    await expect(executeReview({
      mode: "uncommitted",
      workingDirectory,
    })).rejects.toThrow("no final review message");
  });

  it("returns plain text when review output is not JSONL", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "not json\nstill not json",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeReview({
      mode: "uncommitted",
      workingDirectory,
    });

    expect(result.response).toBe("not json\nstill not json");
    expect(result.meta.parseFailures).toBe(2);
  });
});
