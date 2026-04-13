import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import { getGitRoot, getUncommittedDiff, getBranchDiff } from "../../src/utils/git.js";

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe("getGitRoot", () => {
  it("returns trimmed git root on success", () => {
    execFileSyncMock.mockReturnValue("/home/user/repo\n");
    expect(getGitRoot("/home/user/repo/src")).toBe("/home/user/repo");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/home/user/repo/src", "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 5000 },
    );
  });

  it("throws with cause when not a git repo", () => {
    const originalError = new Error("fatal: not a git repository");
    execFileSyncMock.mockImplementation(() => { throw originalError; });

    expect(() => getGitRoot("/tmp/not-a-repo")).toThrow("Not a git repository: /tmp/not-a-repo");
    try {
      getGitRoot("/tmp/not-a-repo");
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).cause).toBe(originalError);
    }
  });
});

describe("getUncommittedDiff", () => {
  it("returns combined staged and unstaged diff", () => {
    execFileSyncMock
      .mockReturnValueOnce("staged changes\n")   // git diff --cached
      .mockReturnValueOnce("unstaged changes\n"); // git diff

    const result = getUncommittedDiff("/repo");
    expect(result).toBe("staged changes\nunstaged changes");
  });

  it("returns only staged diff when unstaged is empty", () => {
    execFileSyncMock
      .mockReturnValueOnce("staged only\n")
      .mockReturnValueOnce("");

    expect(getUncommittedDiff("/repo")).toBe("staged only");
  });

  it("returns only unstaged diff when staged is empty", () => {
    execFileSyncMock
      .mockReturnValueOnce("")
      .mockReturnValueOnce("unstaged only\n");

    expect(getUncommittedDiff("/repo")).toBe("unstaged only");
  });

  it("throws when both staged and unstaged are empty", () => {
    execFileSyncMock.mockReturnValue("");
    expect(() => getUncommittedDiff("/repo")).toThrow("No uncommitted changes found");
  });

  it("uses custom context lines", () => {
    execFileSyncMock
      .mockReturnValueOnce("diff\n")
      .mockReturnValueOnce("");

    getUncommittedDiff("/repo", 10);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "diff", "--cached", "-U10"],
      expect.any(Object),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "diff", "-U10"],
      expect.any(Object),
    );
  });

  it("wraps exec errors with cause", () => {
    const originalError = new Error("git crashed");
    execFileSyncMock.mockImplementation(() => { throw originalError; });

    expect(() => getUncommittedDiff("/repo")).toThrow("Failed to get git diff");
    try {
      getUncommittedDiff("/repo");
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).cause).toBe(originalError);
    }
  });
});

describe("getBranchDiff", () => {
  it("returns trimmed diff between base and HEAD", () => {
    execFileSyncMock.mockReturnValue("diff --git a/file b/file\n+new line\n");

    const result = getBranchDiff("/repo", "main");
    expect(result).toBe("diff --git a/file b/file\n+new line");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "diff", "main...HEAD", "-U5"],
      expect.any(Object),
    );
  });

  it("uses custom context lines", () => {
    execFileSyncMock.mockReturnValue("diff\n");

    getBranchDiff("/repo", "origin/main", 3);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "diff", "origin/main...HEAD", "-U3"],
      expect.any(Object),
    );
  });

  it("throws when diff is empty", () => {
    execFileSyncMock.mockReturnValue("");
    expect(() => getBranchDiff("/repo", "main")).toThrow("No diff found between main and HEAD");
  });

  it("re-throws no-diff error without wrapping", () => {
    execFileSyncMock.mockReturnValue("");
    try {
      getBranchDiff("/repo", "main");
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).cause).toBeUndefined();
    }
  });

  it("wraps exec errors with cause", () => {
    const originalError = new Error("bad ref");
    execFileSyncMock.mockImplementation(() => { throw originalError; });

    expect(() => getBranchDiff("/repo", "nonexistent")).toThrow('Failed to get branch diff against "nonexistent"');
    try {
      getBranchDiff("/repo", "nonexistent");
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).cause).toBe(originalError);
    }
  });
});
