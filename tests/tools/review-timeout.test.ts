import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";

const {
  spawnCodexMock,
  verifyDirectoryMock,
  getGitRootMock,
  getUncommittedDiffMock,
  getBranchDiffMock,
  getDiffStatMock,
} = vi.hoisted(() => ({
  spawnCodexMock: vi.fn<(options: SpawnOptions) => Promise<SpawnResult>>(),
  verifyDirectoryMock: vi.fn<(dir: string) => Promise<string>>(),
  getGitRootMock: vi.fn<(cwd: string) => string>(),
  getUncommittedDiffMock: vi.fn<(cwd: string, contextLines?: number) => string>(),
  getBranchDiffMock: vi.fn<(cwd: string, base: string, contextLines?: number) => string>(),
  getDiffStatMock: vi.fn(),
}));

vi.mock("../../src/utils/spawn.js", () => ({
  spawnCodex: spawnCodexMock,
  HARD_TIMEOUT_CAP: 1_800_000,
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
  getDiffStat: getDiffStatMock,
}));

import { executeReview, scaleAgenticTimeout } from "../../src/tools/review.js";

const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
const origCodexHome = process.env["CODEX_HOME"];

describe("scaleAgenticTimeout", () => {
  it("returns base timeout for 0 files", () => {
    expect(scaleAgenticTimeout({ files: 0, insertions: 0, deletions: 0 })).toBe(180_000);
  });

  it("scales linearly with file count", () => {
    expect(scaleAgenticTimeout({ files: 1, insertions: 10, deletions: 5 })).toBe(210_000);
    expect(scaleAgenticTimeout({ files: 5, insertions: 50, deletions: 20 })).toBe(330_000);
    expect(scaleAgenticTimeout({ files: 10, insertions: 100, deletions: 50 })).toBe(480_000);
  });

  it("caps at HARD_TIMEOUT_CAP (1800s)", () => {
    // 180s + 30s * 60 = 1980s, should cap at 1800s
    expect(scaleAgenticTimeout({ files: 60, insertions: 2000, deletions: 500 })).toBe(1_800_000);
    expect(scaleAgenticTimeout({ files: 100, insertions: 5000, deletions: 2000 })).toBe(1_800_000);
  });

  it("scales correctly: 3 files -> 270s, cap reached at 54 files", () => {
    // 3 files: 180 + 90 = 270s
    expect(scaleAgenticTimeout({ files: 3, insertions: 30, deletions: 10 })).toBe(270_000);
    // 54 files: 180 + 1620 = 1800s (exactly at cap)
    expect(scaleAgenticTimeout({ files: 54, insertions: 500, deletions: 200 })).toBe(1_800_000);
  });
});

describe("review timeout selection", () => {
  beforeEach(() => {
    spawnCodexMock.mockReset();
    verifyDirectoryMock.mockReset();
    getGitRootMock.mockReset();
    getUncommittedDiffMock.mockReset();
    getBranchDiffMock.mockReset();
    getDiffStatMock.mockReset();

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

  it("caller-supplied timeout wins over auto-scaling", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 5, insertions: 50, deletions: 20 });
    spawnCodexMock.mockResolvedValue({
      stdout: "review", stderr: "", exitCode: 0, timedOut: false,
    });

    const result = await executeReview({
      uncommitted: true,
      timeout: 200_000,
    });

    expect(result.appliedTimeout).toBe(200_000);
    expect(result.timeoutScaled).toBe(false);
    expect(result.diffStat).toEqual({ files: 5, insertions: 50, deletions: 20 });
  });

  it("caller timeout is capped at HARD_TIMEOUT_CAP", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue(undefined);
    spawnCodexMock.mockResolvedValue({
      stdout: "review", stderr: "", exitCode: 0, timedOut: false,
    });

    const result = await executeReview({
      uncommitted: true,
      timeout: 9_999_999,
    });

    expect(result.appliedTimeout).toBe(1_800_000);
    expect(result.timeoutScaled).toBe(false);
  });

  it("agentic mode auto-scales from diffStat", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 3, insertions: 30, deletions: 10 });
    spawnCodexMock.mockResolvedValue({
      stdout: "review", stderr: "", exitCode: 0, timedOut: false,
    });

    const result = await executeReview({
      uncommitted: true,
    });

    // 180s + 30s * 3 = 270s
    expect(result.appliedTimeout).toBe(270_000);
    expect(result.timeoutScaled).toBe(true);
    expect(result.diffStat).toEqual({ files: 3, insertions: 30, deletions: 10 });
  });

  it("agentic mode falls back to static timeout when diffStat unavailable", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue(undefined);
    spawnCodexMock.mockResolvedValue({
      stdout: "review", stderr: "", exitCode: 0, timedOut: false,
    });

    const result = await executeReview({
      uncommitted: true,
    });

    expect(result.appliedTimeout).toBe(300_000);
    expect(result.timeoutScaled).toBe(false);
    expect(result.diffStat).toBeUndefined();
  });

  it("quick mode uses static timeout regardless of diffStat", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 10, insertions: 100, deletions: 50 });
    spawnCodexMock.mockResolvedValue({
      stdout: "quick review", stderr: "", exitCode: 0, timedOut: false,
    });

    const result = await executeReview({
      quick: true,
      uncommitted: true,
    });

    expect(result.appliedTimeout).toBe(120_000);
    expect(result.timeoutScaled).toBe(false);
    // diffStat is still reported even in quick mode
    expect(result.diffStat).toEqual({ files: 10, insertions: 100, deletions: 50 });
  });

  it("timeout message includes diff context when timed out with diffStat", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 8, insertions: 200, deletions: 50 });
    spawnCodexMock.mockResolvedValue({
      stdout: "", stderr: "", exitCode: null, timedOut: true,
    });

    const result = await executeReview({
      uncommitted: true,
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("8 files");
    expect(result.response).toContain("+200");
    expect(result.response).toContain("-50");
    expect(result.response).toContain("quick: true");
  });

  it("timeout message is generic when diffStat unavailable", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue(undefined);
    spawnCodexMock.mockResolvedValue({
      stdout: "", stderr: "", exitCode: null, timedOut: true,
    });

    const result = await executeReview({
      uncommitted: true,
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("timed out");
    expect(result.response).toContain("quick: true");
    expect(result.response).not.toContain("files");
  });

  it("quick-mode timeout message does not suggest quick: true", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 3, insertions: 30, deletions: 10 });
    spawnCodexMock.mockResolvedValue({
      stdout: "", stderr: "", exitCode: null, timedOut: true,
    });

    const result = await executeReview({
      quick: true,
      uncommitted: true,
    });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("timed out");
    expect(result.response).toContain("smaller scope");
    expect(result.response).not.toContain("quick: true");
  });

  it("early exit for no changes still includes meta fields", async () => {
    getUncommittedDiffMock.mockImplementation(() => {
      throw new Error("No uncommitted changes found");
    });
    getDiffStatMock.mockReturnValue(undefined);

    const result = await executeReview({
      uncommitted: true,
    });

    expect(result.response).toBe("No uncommitted changes found");
    expect(result.appliedTimeout).toBe(300_000);
    expect(result.timeoutScaled).toBe(false);
    expect(result.diffStat).toBeUndefined();
  });
});
