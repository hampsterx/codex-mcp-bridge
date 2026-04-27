import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeReview } from "../../src/tools/review.js";

const runIntegration = process.env["CODEX_INTEGRATION"] === "1";
const maybeIt = runIntegration ? it : it.skip;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepo(prefix: string): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "codex-review@example.invalid"]);
  git(cwd, ["config", "user.name", "Codex Review Test"]);
  writeFileSync(path.join(cwd, "app.js"), "export function value(input) {\n  return input.value;\n}\n");
  git(cwd, ["add", "app.js"]);
  git(cwd, ["commit", "-q", "-m", "initial"]);
  return cwd;
}

describe("review integration", () => {
  maybeIt("reviews uncommitted, base, and commit diffs", async () => {
    const repos: string[] = [];
    try {
      const dirtyRepo = createRepo("codex-review-dirty-");
      repos.push(dirtyRepo);
      writeFileSync(path.join(dirtyRepo, "app.js"), "export function value(input) {\n  return input.missing.deep;\n}\n");

      const dirty = await executeReview({
        mode: "uncommitted",
        workingDirectory: dirtyRepo,
        timeout: 300_000,
      });
      expect(dirty.response).toMatch(/\[P\d+\]|No blocking findings/i);
      expect(dirty.meta.commands.length).toBeGreaterThan(0);
      expect(dirty.mode).toBe("uncommitted");
      expect(dirty.threadId).toMatch(/^[0-9a-f-]{20,}$/i);
      expect(dirty).not.toHaveProperty("usage");

      const baseRepo = createRepo("codex-review-base-");
      repos.push(baseRepo);
      git(baseRepo, ["checkout", "-q", "-b", "feature"]);
      writeFileSync(path.join(baseRepo, "app.js"), "export function value(input) {\n  return JSON.parse(input);\n}\n");
      git(baseRepo, ["add", "app.js"]);
      git(baseRepo, ["commit", "-q", "-m", "add unsafe parser"]);

      const base = await executeReview({
        mode: "base",
        base: "main",
        workingDirectory: baseRepo,
        timeout: 300_000,
      });
      expect(base.response.length).toBeGreaterThan(0);
      expect(base.meta.commands.length).toBeGreaterThan(0);
      expect(base.mode).toBe("base");
      expect(base.threadId).toMatch(/^[0-9a-f-]{20,}$/i);
      expect(base).not.toHaveProperty("usage");

      const commitRepo = createRepo("codex-review-commit-");
      repos.push(commitRepo);
      writeFileSync(path.join(commitRepo, "app.js"), "export function value(input) {\n  return input.user.password;\n}\n");
      git(commitRepo, ["add", "app.js"]);
      git(commitRepo, ["commit", "-q", "-m", "leak password"]);
      const sha = git(commitRepo, ["rev-parse", "HEAD"]);

      const commit = await executeReview({
        mode: "commit",
        commit: sha,
        workingDirectory: commitRepo,
        timeout: 300_000,
      });
      expect(commit.response.length).toBeGreaterThan(0);
      expect(commit.meta.commands.length).toBeGreaterThan(0);
      expect(commit.mode).toBe("commit");
      expect(commit.threadId).toMatch(/^[0-9a-f-]{20,}$/i);
      expect(commit).not.toHaveProperty("usage");
    } finally {
      for (const repo of repos) {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  }, 900_000);
});
