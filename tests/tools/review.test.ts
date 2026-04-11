import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures");

const {
  spawnCodexMock,
  verifyDirectoryMock,
  getGitRootMock,
  getUncommittedDiffMock,
  getBranchDiffMock,
} = vi.hoisted(() => ({
  spawnCodexMock: vi.fn<(options: SpawnOptions) => Promise<SpawnResult>>(),
  verifyDirectoryMock: vi.fn<(dir: string) => Promise<string>>(),
  getGitRootMock: vi.fn<(cwd: string) => string>(),
  getUncommittedDiffMock: vi.fn<(cwd: string, contextLines?: number) => string>(),
  getBranchDiffMock: vi.fn<(cwd: string, base: string, contextLines?: number) => string>(),
}));

vi.mock("../../src/utils/spawn.js", () => ({
  spawnCodex: spawnCodexMock,
}));

vi.mock("../../src/utils/security.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/security.js")>("../../src/utils/security.js");
  return {
    ...actual,
    verifyDirectory: verifyDirectoryMock,
  };
});

vi.mock("../../src/utils/git.js", () => ({
  getGitRoot: getGitRootMock,
  getUncommittedDiff: getUncommittedDiffMock,
  getBranchDiff: getBranchDiffMock,
}));

import { executeReview } from "../../src/tools/review.js";

// Inherit keeps the override empty so tool-level tests don't depend on
// ~/.codex/config.toml contents.
const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
const origCodexHome = process.env["CODEX_HOME"];

describe("executeReview", () => {
  beforeEach(() => {
    spawnCodexMock.mockReset();
    verifyDirectoryMock.mockReset();
    getGitRootMock.mockReset();
    getUncommittedDiffMock.mockReset();
    getBranchDiffMock.mockReset();

    verifyDirectoryMock.mockResolvedValue("/repo/requested");
    getGitRootMock.mockReturnValue("/repo/root");

    process.env["CODEX_MCP_SERVERS"] = "inherit";
    delete process.env["CODEX_HOME"];
  });

  afterEach(() => {
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  it("uses full-auto for agentic review and returns parsed response", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "review findings",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeReview({
      quick: false,
      uncommitted: true,
      model: "o3",
      workingDirectory: "/repo/requested",
    });

    expect(getGitRootMock).toHaveBeenCalledWith("/repo/requested");
    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.cwd).toBe("/repo/root");
    expect(call.args).toEqual(["exec", "--model", "o3", "--full-auto", "--skip-git-repo-check"]);
    expect(call.stdin).toContain("git diff HEAD -U5");
    expect(result.mode).toBe("agentic");
    expect(result.diffSource).toBe("uncommitted");
    expect(result.response).toBe("review findings");
    expect(result.model).toBe("o3");
  });

  it("returns early when quick review has no uncommitted changes", async () => {
    getUncommittedDiffMock.mockImplementation(() => {
      throw new Error("No uncommitted changes found");
    });

    const result = await executeReview({
      quick: true,
      uncommitted: true,
    });

    expect(spawnCodexMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("quick");
    expect(result.response).toBe("No uncommitted changes found");
    expect(result.model).toBeUndefined();
  });

  it("agentic mode defaults to CODEX_MCP_SERVERS=serena (enables serena, disables others)", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "review findings",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    // Point at the mixed fixture (github, playwright, serena) and clear env so
    // the tool default takes effect.
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-mixed");

    await executeReview({
      quick: false,
      uncommitted: true,
      model: "o3",
      workingDirectory: "/repo/requested",
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    // serena kept enabled, github + playwright disabled.
    expect(call.args).toEqual([
      "exec",
      "-c", "mcp_servers.github.enabled=false",
      "-c", "mcp_servers.playwright.enabled=false",
      "--model", "o3",
      "--full-auto",
      "--skip-git-repo-check",
    ]);
  });

  it("quick mode default is disable-all (no serena default)", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "quick review",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-mixed");

    await executeReview({
      quick: true,
      uncommitted: true,
      model: "o3",
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args).toEqual([
      "exec",
      "-c", "mcp_servers.github.enabled=false",
      "-c", "mcp_servers.playwright.enabled=false",
      "-c", "mcp_servers.serena.enabled=false",
      "--model", "o3",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
    ]);
  });

  it("agentic tool-default 'serena' is silent when serena is not configured", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "review findings",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    // Fixture has playwright + github only, no serena. The tool default
    // would normally emit "ignoring unknown MCP server 'serena'" — assert
    // that doesn't happen because silent:true is passed.
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-url");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await executeReview({ quick: false, uncommitted: true, model: "o3" });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("explicit mcpServers input parameter keeps warnings noisy", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "ok", stderr: "", exitCode: 0, timedOut: false,
    });

    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-url");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await executeReview({
        quick: false,
        uncommitted: true,
        model: "o3",
        mcpServers: "serena", // user explicitly asked for a non-existent server
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ignoring unknown MCP server 'serena'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("explicit mcpServers input parameter wins over env var and defaults", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    process.env["CODEX_MCP_SERVERS"] = "inherit"; // would normally passthrough
    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-mixed");

    await executeReview({
      quick: false,
      uncommitted: true,
      model: "o3",
      mcpServers: "github", // explicit: enable github only
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args).toEqual([
      "exec",
      "-c", "mcp_servers.playwright.enabled=false",
      "-c", "mcp_servers.serena.enabled=false",
      "--model", "o3",
      "--full-auto",
      "--skip-git-repo-check",
    ]);
  });

  it("uses read-only sandbox for quick branch review", async () => {
    getBranchDiffMock.mockReturnValue("diff --git a/y b/y");
    spawnCodexMock.mockResolvedValue({
      stdout: "quick review",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeReview({
      quick: true,
      base: "main",
      model: "o3",
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args).toEqual(["exec", "--model", "o3", "--sandbox", "read-only", "--skip-git-repo-check"]);
    expect(call.stdin).toContain("diff --git a/y b/y");
    expect(result.mode).toBe("quick");
    expect(result.diffSource).toBe("branch");
    expect(result.base).toBe("main");
    expect(result.model).toBe("o3");
  });
});
