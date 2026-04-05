import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";
import { sessionStore } from "../../src/utils/session.js";

const { spawnCodexMock } = vi.hoisted(() => ({
  spawnCodexMock: vi.fn<(options: SpawnOptions) => Promise<SpawnResult>>(),
}));

vi.mock("../../src/utils/spawn.js", () => ({
  spawnCodex: spawnCodexMock,
}));

import { buildArgs, executeCodex } from "../../src/tools/codex.js";

describe("buildArgs", () => {
  it("builds basic exec args with json and sandbox", () => {
    expect(buildArgs({
      model: "o3",
      sandbox: "read-only",
    })).toEqual([
      "exec",
      "--json",
      "--model",
      "o3",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
    ]);
  });

  it("uses full-auto without combining sandbox flags", () => {
    expect(buildArgs({
      model: "o3",
      sandbox: "full-auto",
    })).toEqual([
      "exec",
      "--json",
      "--model",
      "o3",
      "--full-auto",
      "--skip-git-repo-check",
    ]);
  });

  it("builds resume args with config overrides", () => {
    expect(buildArgs({
      model: "o3",
      reasoningEffort: "high",
      conversationId: "thread_abc",
    })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      "model=\"o3\"",
      "resume",
      "thread_abc",
      "-c",
      "model_reasoning_effort=\"high\"",
    ]);
  });

  it("includes output file and image paths", () => {
    expect(buildArgs({
      model: "o3",
      outputFile: "/tmp/response.txt",
      imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
      prompt: "hello",
    })).toEqual([
      "exec",
      "--json",
      "--model",
      "o3",
      "--skip-git-repo-check",
      "-o",
      "/tmp/response.txt",
      "-i",
      "/tmp/a.png",
      "-i",
      "/tmp/b.jpg",
      "hello",
    ]);
  });
});

describe("executeCodex", () => {
  beforeEach(() => {
    spawnCodexMock.mockReset();
    for (const { sessionId } of sessionStore.list()) {
      sessionStore.delete(sessionId);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the final response from the output file and stores the session", async () => {
    spawnCodexMock.mockImplementation(async ({ args }) => {
      const outputIndex = args.indexOf("-o");
      expect(outputIndex).toBeGreaterThan(-1);
      await writeFile(args[outputIndex + 1]!, "Final response from file\n", "utf8");
      return {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread_abc123" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "item_0", type: "agent_message", text: "Fallback JSONL response" },
          }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await executeCodex({
      prompt: "What is 2 + 2?",
      model: "o3",
      sandbox: "read-only",
    });

    expect(spawnCodexMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnCodexMock.mock.calls[0]![0].args;
    expect(spawnArgs).toContain("--json");
    expect(spawnArgs).toContain("--sandbox");
    expect(spawnArgs).toContain("read-only");
    expect(result.response).toBe("Final response from file");
    expect(result.conversationId).toBe("thread_abc123");
    expect(result.sessionId).toMatch(/^codex-/);
  });
});
