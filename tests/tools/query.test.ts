import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";

const { spawnCodexMock, mkdtempMock, rmMock } = vi.hoisted(() => ({
  spawnCodexMock: vi.fn<(options: SpawnOptions) => Promise<SpawnResult>>(),
  mkdtempMock: vi.fn<(prefix: string) => Promise<string>>(),
  rmMock: vi.fn<(path: string, options?: object) => Promise<void>>(),
}));

vi.mock("../../src/utils/spawn.js", () => ({
  spawnCodex: spawnCodexMock,
  HARD_TIMEOUT_CAP: 1_800_000,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdtemp: mkdtempMock,
    rm: rmMock,
  };
});

import { executeQuery } from "../../src/tools/query.js";

const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
const origCodexHome = process.env["CODEX_HOME"];

describe("executeQuery", () => {
  beforeEach(() => {
    spawnCodexMock.mockReset();
    mkdtempMock.mockReset();
    rmMock.mockReset();
    mkdtempMock.mockResolvedValue("/tmp/codex-query-abc123");
    rmMock.mockResolvedValue(undefined);
    process.env["CODEX_MCP_SERVERS"] = "inherit";
    delete process.env["CODEX_HOME"];
  });

  afterEach(() => {
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  it("uses correct CLI flags: --sandbox read-only --skip-git-repo-check --ephemeral", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "query response",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    await executeQuery({ prompt: "analyze this" });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args).toContain("--sandbox");
    expect(call.args).toContain("read-only");
    expect(call.args).toContain("--skip-git-repo-check");
    expect(call.args).toContain("--ephemeral");
    expect(call.args).toContain("exec");
    expect(call.args).toContain("--json");
    // Verify no MCP servers are explicitly enabled (no --mcp-servers or inherit)
    expect(call.args).not.toContain("inherit");
  });

  it("wires reasoningEffort into CLI args", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "response",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    await executeQuery({ prompt: "test", reasoningEffort: "high" });

    const call = spawnCodexMock.mock.calls[0]![0];
    // Find the -c flag followed by the reasoning effort config
    // (there may be earlier -c flags from MCP server overrides)
    const reasoningIdx = call.args.findIndex(
      (arg: string, i: number) =>
        arg === "-c" && call.args[i + 1]?.startsWith("model_reasoning_effort"),
    );
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[reasoningIdx + 1]).toBe('model_reasoning_effort="high"');
  });

  it("passes prompt and context via stdin template", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "analysis result",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeQuery({
      prompt: "summarize this",
      context: "some text to analyze",
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.stdin).toContain("summarize this");
    expect(call.stdin).toContain("some text to analyze");
    // Caller text must never reach argv, where Codex would option-parse it.
    // query has no positional prompt at all, and must keep it that way.
    expect(call.args.join(" ")).not.toContain("summarize this");
    expect(call.args.join(" ")).not.toContain("some text to analyze");
    expect(result.response).toBe("analysis result");
  });

  it("uses a temp dir as cwd, not process.cwd()", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "response",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    await executeQuery({ prompt: "test" });

    expect(mkdtempMock).toHaveBeenCalledTimes(1);
    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.cwd).toBe("/tmp/codex-query-abc123");
  });

  it("cleans up temp dir after execution", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "response",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    await executeQuery({ prompt: "test" });

    expect(rmMock).toHaveBeenCalledWith(
      "/tmp/codex-query-abc123",
      { recursive: true, force: true },
    );
  });

  it("defaults timeout to 60s", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "response",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    await executeQuery({ prompt: "test" });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.timeout).toBe(60_000);
  });

  it("returns timeout response without parsing output", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeQuery({ prompt: "slow query", timeout: 5000 });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("5s");
  });

  it("does not include session data in response", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "response text",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeQuery({ prompt: "test" });

    // QueryResult has no sessionId or conversationId fields
    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("conversationId");
    expect(result.response).toBe("response text");
    expect(result.timedOut).toBe(false);
  });

  it("sets model when provided", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "response",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeQuery({ prompt: "test", model: "gpt-4.1" });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args.some((a: string) => a.startsWith("--model="))).toBe(true);
    expect(call.args).toContain("--model=gpt-4.1");
    expect(result.model).toBe("gpt-4.1");
  });

  it("uses default context placeholder when no context provided", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "response",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    await executeQuery({ prompt: "general question" });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.stdin).toContain("general question");
    expect(call.stdin).toContain("No additional context provided");
  });
});
