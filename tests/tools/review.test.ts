import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";

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

describe("executeReview", () => {
  beforeEach(() => {
    spawnCodexMock.mockReset();
    verifyDirectoryMock.mockReset();
    getGitRootMock.mockReset();
    getUncommittedDiffMock.mockReset();
    getBranchDiffMock.mockReset();

    verifyDirectoryMock.mockResolvedValue("/repo/requested");
    getGitRootMock.mockReturnValue("/repo/root");
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
  });
});
