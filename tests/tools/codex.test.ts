import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";
import { sessionStore } from "../../src/utils/session.js";

const { spawnCodexMock } = vi.hoisted(() => ({
  spawnCodexMock: vi.fn<(options: SpawnOptions) => Promise<SpawnResult>>(),
}));

vi.mock("../../src/utils/spawn.js", () => ({
  spawnCodex: spawnCodexMock,
  HARD_TIMEOUT_CAP: 1_800_000,
}));

import { buildArgs, executeCodex } from "../../src/tools/codex.js";

// Inherit keeps the override empty so tool-level tests don't depend on
// ~/.codex/config.toml contents. Override semantics are tested in env.test.ts
// and codex-config.test.ts.
const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
const origCodexHome = process.env["CODEX_HOME"];

beforeEach(() => {
  process.env["CODEX_MCP_SERVERS"] = "inherit";
  delete process.env["CODEX_HOME"];
});

afterEach(() => {
  if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
  else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
  if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = origCodexHome;
});

describe("buildArgs", () => {
  it("builds basic exec args with json and sandbox", () => {
    expect(buildArgs({
      model: "o3",
      sandbox: "read-only",
    })).toEqual([
      "exec",
      "--json",
      "--model=o3",
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
      "--model=o3",
      "--full-auto",
      "--skip-git-repo-check",
    ]);
  });

  it("builds resume args with config overrides", () => {
    expect(buildArgs({
      model: "o3",
      sandbox: "read-only",
      reasoningEffort: "high",
      conversationId: "thread_abc",
    })).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
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
      "--model=o3",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-o",
      "/tmp/response.txt",
      "-i",
      "/tmp/a.png",
      "-i",
      "/tmp/b.jpg",
      "--",
      "hello",
    ]);
  });
});

describe("buildArgs argument injection", () => {
  // Codex option-parses the trailing PROMPT positional. Without `--`,
  // `codex exec --sandbox read-only --skip-git-repo-check "--version"` prints
  // the CLI version instead of sending the prompt to the model.
  it("separates a dash-prefixed prompt from the flags before it", () => {
    const args = buildArgs({ sandbox: "read-only", prompt: "--version" });
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("--version");
  });

  it("separates a prompt that would otherwise land as a config override", () => {
    const payload = '-cmcp_servers={evil={command="touch",args=["/tmp/pwned"]}}';
    const args = buildArgs({ sandbox: "read-only", prompt: payload });
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe(payload);
  });

  it("separates the prompt on the resume path too", () => {
    const args = buildArgs({ conversationId: "thread_abc", prompt: "--version" });
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("--version");
  });

  // `-i/--image` is variadic on `codex exec`, so a bare prompt straight after
  // the last image path is read as another image rather than as the prompt.
  it("separates the prompt from a preceding variadic image list", () => {
    const args = buildArgs({
      imagePaths: ["/tmp/a.png", "/tmp/b.png"],
      prompt: "describe these",
    });
    expect(args.slice(-4)).toEqual(["-i", "/tmp/b.png", "--", "describe these"]);
  });

  // A second TOML key crammed into the model value is inert, because Codex
  // parses the `-c` value portion as a single TOML value and ignores what
  // follows, but the value must still stay inside its own token.
  it("keeps a quote-breakout model value confined to one -c token", () => {
    const args = buildArgs({
      model: 'o3", sandbox_mode="danger-full-access',
      conversationId: "thread_abc",
    });
    const idx = args.indexOf("-c");
    expect(args[idx + 1]).toBe('model="o3", sandbox_mode="danger-full-access"');
    expect(args).not.toContain('sandbox_mode="danger-full-access"');
  });

  it("omits the separator when the prompt goes over stdin", () => {
    expect(buildArgs({ sandbox: "read-only", imagePaths: ["/tmp/a.png"] })).not.toContain("--");
  });

  // Emitting no sandbox flag on resume hands the decision to user config and
  // project trust, which resolves to workspace-write in a trusted directory.
  // `--sandbox` and `--full-auto` are parent `exec` flags, so both have to land
  // before the subcommand.
  it.each(["read-only", "workspace-write", "full-auto"] as const)(
    "carries sandbox %s onto the resume path, before the subcommand",
    (sandbox) => {
      const args = buildArgs({ sandbox, conversationId: "thread_abc" });
      const flag = sandbox === "full-auto" ? "--full-auto" : "--sandbox";
      expect(args).toContain(flag);
      expect(args.indexOf(flag)).toBeLessThan(args.indexOf("resume"));
    },
  );

  // The read-only default lives in buildArgs, not only in the MCP input schema,
  // so a caller that reaches the builder directly cannot fall back to config.
  it("defaults an unspecified sandbox to read-only on both paths", () => {
    expect(buildArgs({})).toContain("--sandbox");
    expect(buildArgs({}).join(" ")).toContain("--sandbox read-only");
    expect(buildArgs({ conversationId: "t" }).join(" ")).toContain("--sandbox read-only");
  });

  it("separates the prompt from images on the resume path", () => {
    const args = buildArgs({
      conversationId: "thread_abc",
      imagePaths: ["/tmp/a.png"],
      prompt: "describe this",
    });
    expect(args.slice(-4)).toEqual(["-i", "/tmp/a.png", "--", "describe this"]);
  });

  // reasoningEffort is schema-constrained to an enum today. It shares the
  // `-c key="value"` shape with model, so pin that a value stays inside its
  // own token if the enum is ever relaxed.
  it("keeps reasoningEffort confined to one -c token", () => {
    const args = buildArgs({ sandbox: "read-only", reasoningEffort: "high" });
    const idx = args.indexOf("-c");
    expect(args[idx + 1]).toBe('model_reasoning_effort="high"');
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

  it("falls back to JSONL-parsed response when output file is empty", async () => {
    spawnCodexMock.mockImplementation(async ({ args }) => {
      const outputIndex = args.indexOf("-o");
      // Write an empty file (readOutputFile returns undefined)
      if (outputIndex > -1) {
        await writeFile(args[outputIndex + 1]!, "", "utf8");
      }
      return {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread_fallback" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "item_0", type: "agent_message", text: "JSONL fallback response" },
          }),
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await executeCodex({
      prompt: "Test fallback",
      model: "o3",
    });

    expect(result.response).toBe("JSONL fallback response");
  });

  it("falls back to JSONL-parsed response when output file is not created by CLI", async () => {
    spawnCodexMock.mockImplementation(async () => ({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread_nofile" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "No file response" },
        }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));

    const result = await executeCodex({
      prompt: "Test no file",
      model: "o3",
    });

    // No -o flag means no output file, falls back to JSONL parsing
    expect(result.response).toBe("No file response");
  });

  it("skips images exceeding MAX_IMAGE_FILE_SIZE and reports them", async () => {
    const securityMod = await import("../../src/utils/security.js");
    const resolveAndVerifySpy = vi.spyOn(securityMod, "resolveAndVerify");
    const checkFileSizeSpy = vi.spyOn(securityMod, "checkFileSize");

    resolveAndVerifySpy.mockResolvedValue("/resolved/huge.png");
    checkFileSizeSpy.mockResolvedValue(6_000_000); // 6MB, over 5MB limit

    spawnCodexMock.mockImplementation(async ({ args }) => {
      const outputIndex = args.indexOf("-o");
      if (outputIndex > -1) {
        await writeFile(args[outputIndex + 1]!, "Response\n", "utf8");
      }
      return {
        stdout: JSON.stringify({ type: "thread.started", thread_id: "thread_img" }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await executeCodex({
      prompt: "Analyze image",
      model: "o3",
      files: ["huge.png"],
    });

    expect(result.imagesIncluded).toEqual([]);
    expect(result.filesSkipped.length).toBe(1);
    expect(result.filesSkipped[0]).toContain("exceeds");

    resolveAndVerifySpy.mockRestore();
    checkFileSizeSpy.mockRestore();
  });

  it("continues without session when sessionStore.set throws", async () => {
    spawnCodexMock.mockImplementation(async ({ args }) => {
      const outputIndex = args.indexOf("-o");
      if (outputIndex > -1) {
        await writeFile(args[outputIndex + 1]!, "Result\n", "utf8");
      }
      return {
        stdout: JSON.stringify({ type: "thread.started", thread_id: "thread_err" }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });

    vi.spyOn(sessionStore, "set").mockImplementation(() => {
      throw new Error("Storage full");
    });

    const result = await executeCodex({
      prompt: "Test session error",
      model: "o3",
    });

    // Should succeed without sessionId since storage failed
    expect(result.response).toBe("Result");
    expect(result.sessionId).toBeUndefined();

    vi.restoreAllMocks();
  });

  it("returns timeout response when subprocess times out", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeCodex({
      prompt: "Slow query",
      model: "o3",
      timeout: 5000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("timed out");
  });

  it("resetSession clears the session before executing", async () => {
    // Pre-populate a session
    sessionStore.set("my-session", {
      conversationId: "old_thread",
      model: "o3",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      turnCount: 5,
    });

    spawnCodexMock.mockImplementation(async ({ args }) => {
      const outputIndex = args.indexOf("-o");
      if (outputIndex > -1) {
        await writeFile(args[outputIndex + 1]!, "Fresh start\n", "utf8");
      }
      return {
        stdout: JSON.stringify({ type: "thread.started", thread_id: "new_thread" }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    });

    const result = await executeCodex({
      prompt: "Start fresh",
      model: "o3",
      sessionId: "my-session",
      resetSession: true,
    });

    // Should NOT have used the old conversationId (no "resume" in args)
    const spawnArgs = spawnCodexMock.mock.calls[0]![0].args;
    expect(spawnArgs).not.toContain("resume");
    expect(spawnArgs).not.toContain("old_thread");

    // New session should be stored
    expect(result.conversationId).toBe("new_thread");
    expect(result.sessionId).toBe("my-session");

    // Session store should have the new conversationId with turn count reset
    const stored = sessionStore.get("my-session");
    expect(stored).toBeDefined();
    expect(stored!.conversationId).toBe("new_thread");
    expect(stored!.turnCount).toBe(1); // reset: previous deleted, fresh start
  });
});
