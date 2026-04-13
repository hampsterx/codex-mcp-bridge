import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import { getGitRoot, getUncommittedDiff, getBranchDiff, parseNumstat, getDiffStat } from "../../src/utils/git.js";

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

describe("parseNumstat", () => {
  it("parses standard numstat output", () => {
    const output = "10\t5\tsrc/foo.ts\n3\t1\tsrc/bar.ts\n";
    expect(parseNumstat(output)).toEqual({ files: 2, insertions: 13, deletions: 6 });
  });

  it("handles binary files (- for insertions/deletions)", () => {
    const output = "-\t-\timage.png\n5\t2\tsrc/code.ts\n";
    expect(parseNumstat(output)).toEqual({ files: 2, insertions: 5, deletions: 2 });
  });

  it("handles renames as a single file", () => {
    const output = "0\t0\t{old => new}/file.ts\n";
    expect(parseNumstat(output)).toEqual({ files: 1, insertions: 0, deletions: 0 });
  });

  it("returns zeros for empty output", () => {
    expect(parseNumstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(parseNumstat("\n\n")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it("skips malformed lines (fewer than 3 tab-separated fields)", () => {
    const output = "not a numstat line\n10\t5\tsrc/valid.ts\n";
    expect(parseNumstat(output)).toEqual({ files: 1, insertions: 10, deletions: 5 });
  });

  it("handles single file", () => {
    const output = "42\t0\tREADME.md\n";
    expect(parseNumstat(output)).toEqual({ files: 1, insertions: 42, deletions: 0 });
  });
});

describe("getDiffStat", () => {
  it("returns parsed stat for uncommitted changes", () => {
    execFileSyncMock.mockReturnValue("10\t5\tsrc/foo.ts\n3\t1\tsrc/bar.ts\n");
    const result = getDiffStat("/repo", { type: "uncommitted" });
    expect(result).toEqual({ files: 2, insertions: 13, deletions: 6 });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "diff", "--numstat", "HEAD"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("returns parsed stat for branch diff", () => {
    execFileSyncMock.mockReturnValue("7\t2\tsrc/x.ts\n");
    const result = getDiffStat("/repo", { type: "branch", base: "main" });
    expect(result).toEqual({ files: 1, insertions: 7, deletions: 2 });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "diff", "--numstat", "main...HEAD"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("returns undefined when diff is empty (no files)", () => {
    execFileSyncMock.mockReturnValue("");
    expect(getDiffStat("/repo", { type: "uncommitted" })).toBeUndefined();
  });

  it("returns undefined on git error", () => {
    execFileSyncMock.mockImplementation(() => { throw new Error("not a repo"); });
    expect(getDiffStat("/tmp/nope", { type: "uncommitted" })).toBeUndefined();
  });
});
