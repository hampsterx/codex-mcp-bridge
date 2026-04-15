import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { DiffStat } from "../../src/utils/git.js";
import {
  classifyComplexity,
  buildSuggestions,
  executeAssess,
} from "../../src/tools/assess.js";

// ---------------------------------------------------------------------------
// classifyComplexity
// ---------------------------------------------------------------------------

const stat = (files: number, ins = 0, del = 0): DiffStat => ({
  files,
  insertions: ins,
  deletions: del,
});

describe("classifyComplexity", () => {
  it("returns trivial for ≤3 files, ≤50 lines, no package manifests", () => {
    expect(classifyComplexity(stat(1, 20, 10), ["src/foo.ts"])).toBe("trivial");
    expect(classifyComplexity(stat(3, 30, 20), ["src/a.ts", "src/b.ts", "src/c.ts"])).toBe(
      "trivial",
    );
  });

  it("returns trivial for 0 files", () => {
    expect(classifyComplexity(stat(0), [])).toBe("trivial");
  });

  it("boundary: exactly 50 lines with 3 files is trivial", () => {
    expect(classifyComplexity(stat(3, 30, 20), ["src/a.ts", "src/b.ts", "src/c.ts"])).toBe(
      "trivial",
    );
  });

  it("boundary: 51 lines promotes to moderate", () => {
    expect(classifyComplexity(stat(3, 30, 21), ["src/a.ts", "src/b.ts", "src/c.ts"])).toBe(
      "moderate",
    );
  });

  it("boundary: 4 files promotes to moderate", () => {
    expect(
      classifyComplexity(stat(4, 10, 10), ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]),
    ).toBe("moderate");
  });

  it("returns moderate for 4-10 files under thresholds", () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    expect(classifyComplexity(stat(10, 100, 100), files)).toBe("moderate");
  });

  it("returns complex for >10 files", () => {
    const files = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
    expect(classifyComplexity(stat(11, 10, 5), files)).toBe("complex");
  });

  it("returns complex for >300 total lines", () => {
    expect(classifyComplexity(stat(2, 200, 101), ["src/a.ts", "src/b.ts"])).toBe("complex");
  });

  it("returns complex for 3+ distinct top-level dirs", () => {
    const files = ["src/app.ts", "tests/app.test.ts", "docs/README.md"];
    expect(classifyComplexity(stat(3, 10, 5), files)).toBe("complex");
  });

  it("does not treat 2 top-level dirs as cross-cutting (stays moderate)", () => {
    // 3 files, 60 lines → over the 50-line trivial ceiling, but only 2 dirs → moderate not complex
    const files = ["src/a.ts", "tests/a.test.ts", "tests/b.test.ts"];
    expect(classifyComplexity(stat(3, 40, 20), files)).toBe("moderate");
  });

  it("root-level files share the '.' bucket", () => {
    // 3 root files → 1 bucket → not cross-cutting. No package manifests → trivial.
    const files = ["README.md", "CHANGELOG.md", "LICENSE"];
    expect(classifyComplexity(stat(3, 10, 5), files)).toBe("trivial");
  });

  it("promotes to complex when a package manifest changes (package.json)", () => {
    expect(classifyComplexity(stat(1, 3, 1), ["package.json"])).toBe("complex");
  });

  it("promotes to complex for tsconfig.json, Cargo.toml, go.mod, pyproject.toml", () => {
    for (const file of ["tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml"]) {
      expect(classifyComplexity(stat(1, 5, 5), [file])).toBe("complex");
    }
  });

  it("promotes to complex for lockfiles (*.lock, package-lock.json)", () => {
    expect(classifyComplexity(stat(1, 500, 0), ["package-lock.json"])).toBe("complex");
    expect(classifyComplexity(stat(1, 10, 5), ["yarn.lock"])).toBe("complex");
    expect(classifyComplexity(stat(1, 10, 5), ["Cargo.lock"])).toBe("complex");
  });

  it("promotes to complex for requirements*.txt", () => {
    expect(classifyComplexity(stat(1, 5, 5), ["requirements.txt"])).toBe("complex");
    expect(classifyComplexity(stat(1, 5, 5), ["requirements-dev.txt"])).toBe("complex");
  });

  it("matches package manifest basename in nested monorepo packages", () => {
    expect(classifyComplexity(stat(1, 5, 5), ["packages/api/package.json"])).toBe("complex");
  });

  it("does not flag unrelated JSON files as package manifests", () => {
    expect(classifyComplexity(stat(1, 5, 5), ["src/fixtures/data.json"])).toBe("trivial");
  });
});

// ---------------------------------------------------------------------------
// buildSuggestions
// ---------------------------------------------------------------------------

describe("buildSuggestions", () => {
  it("returns three suggestions: scan, focused, deep", () => {
    const suggestions = buildSuggestions({ files: 5, insertions: 100, deletions: 50 });
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]!.depth).toBe("scan");
    expect(suggestions[1]!.depth).toBe("focused");
    expect(suggestions[2]!.depth).toBe("deep");
  });

  it("scan estimate is fixed regardless of diff size", () => {
    expect(buildSuggestions({ files: 0, insertions: 0, deletions: 0 })[0]!.estimatedSeconds).toBe(30);
    expect(buildSuggestions({ files: 50, insertions: 1000, deletions: 500 })[0]!.estimatedSeconds).toBe(30);
  });

  it("focused estimate scales with file count", () => {
    expect(buildSuggestions({ files: 1, insertions: 0, deletions: 0 })[1]!.estimatedSeconds).toBe(40);
    expect(buildSuggestions({ files: 5, insertions: 0, deletions: 0 })[1]!.estimatedSeconds).toBe(80);
  });

  it("focused estimate caps at 240s", () => {
    expect(buildSuggestions({ files: 100, insertions: 0, deletions: 0 })[1]!.estimatedSeconds).toBe(240);
  });

  it("deep estimate scales with file count", () => {
    expect(buildSuggestions({ files: 1, insertions: 0, deletions: 0 })[2]!.estimatedSeconds).toBe(85);
    expect(buildSuggestions({ files: 5, insertions: 0, deletions: 0 })[2]!.estimatedSeconds).toBe(185);
  });

  it("deep estimate caps at 1200s", () => {
    expect(buildSuggestions({ files: 100, insertions: 0, deletions: 0 })[2]!.estimatedSeconds).toBe(1200);
  });

  it("all suggestions have non-empty descriptions", () => {
    for (const s of buildSuggestions({ files: 3, insertions: 50, deletions: 10 })) {
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// executeAssess (integration, real temp git repos)
// ---------------------------------------------------------------------------

async function initRepo(dir: string): Promise<void> {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "README.md"), "initial\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
}

describe("executeAssess", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cmb-assess-test-"));
    await initRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns trivial for a small uncommitted change", async () => {
    await writeFile(path.join(tmpDir, "file.txt"), "hello\n");
    execFileSync("git", ["-C", tmpDir, "add", "file.txt"], { stdio: "pipe" });

    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("trivial");
    expect(result.diffStat.files).toBe(1);
    expect(result.changedFiles).toContain("file.txt");
    expect(result.suggestions).toHaveLength(3);
    expect(result.resolvedCwd).toBeTruthy();
  });

  it("returns moderate for 4 files under line thresholds", async () => {
    for (let i = 0; i < 4; i++) {
      await writeFile(path.join(tmpDir, `file${i}.txt`), `content ${i}\n`);
    }
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });

    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("moderate");
    expect(result.diffStat.files).toBe(4);
    expect(result.changedFiles).toHaveLength(4);
  });

  it("returns complex for cross-cutting changes (3 top-level dirs)", async () => {
    await mkdir(path.join(tmpDir, "src"), { recursive: true });
    await mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await mkdir(path.join(tmpDir, "docs"), { recursive: true });
    await writeFile(path.join(tmpDir, "src", "app.ts"), "export {};\n");
    await writeFile(path.join(tmpDir, "tests", "app.test.ts"), "test();\n");
    await writeFile(path.join(tmpDir, "docs", "notes.md"), "notes\n");
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });

    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("complex");
    expect(result.changedFiles).toHaveLength(3);
  });

  it("returns complex when a root config file changes", async () => {
    await writeFile(path.join(tmpDir, "package.json"), '{"name":"test"}\n');
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });

    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("complex");
    expect(result.changedFiles).toContain("package.json");
  });

  it("works with base branch diff", async () => {
    execFileSync("git", ["-C", tmpDir, "branch", "base-ref"], { stdio: "pipe" });
    execFileSync("git", ["-C", tmpDir, "checkout", "-b", "feature"], { stdio: "pipe" });
    await writeFile(path.join(tmpDir, "new.txt"), "new file\n");
    execFileSync("git", ["-C", tmpDir, "add", "new.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", tmpDir, "commit", "-q", "-m", "add new"], {
      stdio: "pipe",
    });

    const result = await executeAssess({
      workingDirectory: tmpDir,
      base: "base-ref",
    });

    expect(result.diffStat.files).toBe(1);
    expect(result.changedFiles).toContain("new.txt");
  });

  it("accepts ancestry syntax base (HEAD~1) — parity with review", async () => {
    // Commit a second file so HEAD~1 has content to diff against.
    await writeFile(path.join(tmpDir, "second.txt"), "second\n");
    execFileSync("git", ["-C", tmpDir, "add", "second.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", tmpDir, "commit", "-q", "-m", "second"], { stdio: "pipe" });

    const result = await executeAssess({
      workingDirectory: tmpDir,
      base: "HEAD~1",
    });

    expect(result.diffStat.files).toBe(1);
    expect(result.changedFiles).toContain("second.txt");
  });

  it("returns trivial with empty stats when no changes", async () => {
    const result = await executeAssess({ workingDirectory: tmpDir });

    expect(result.complexity).toBe("trivial");
    expect(result.diffStat.files).toBe(0);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.suggestions).toHaveLength(3);
  });

  it("throws when uncommitted is false and no base is set", async () => {
    await expect(
      executeAssess({ workingDirectory: tmpDir, uncommitted: false }),
    ).rejects.toThrow("Either 'uncommitted' must be true or 'base' must be specified");
  });

  it("resolvedCwd points to git root when called from subdirectory", async () => {
    await mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await writeFile(path.join(tmpDir, "sub", "file.txt"), "content\n");
    execFileSync("git", ["-C", tmpDir, "add", "-A"], { stdio: "pipe" });

    const result = await executeAssess({
      workingDirectory: path.join(tmpDir, "sub"),
    });

    expect(result.resolvedCwd).not.toMatch(/\/sub$/);
    expect(result.changedFiles).toContain("sub/file.txt");
  });
});
