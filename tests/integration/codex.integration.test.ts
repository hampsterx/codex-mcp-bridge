import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgs } from "../../src/tools/codex.js";

const runIntegration = process.env["CODEX_INTEGRATION"] === "1";
const maybeIt = runIntegration ? it : it.skip;

/**
 * Run the real Codex CLI with an argv array straight out of `buildArgs`.
 *
 * The unit tests assert argv shape; these assert that Codex accepts that shape
 * and reads the prompt as a prompt. That distinction is the whole point of the
 * `--` separator, and it cannot be checked against a mock.
 */
function runCodex(args: string[], cwd: string): string {
  try {
    return execFileSync("codex", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

function scratchDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codex-argv-"));
}

describe("codex integration", () => {
  maybeIt("is enabled explicitly via CODEX_INTEGRATION=1", () => {
    expect(runIntegration).toBe(true);
  });

  // Without `--`, Codex option-parses the trailing positional and this prints
  // the CLI version instead of starting a turn.
  maybeIt("treats a dash-prefixed prompt as prompt text, not as a flag", () => {
    const cwd = scratchDir();
    try {
      const out = runCodex(buildArgs({ sandbox: "read-only", prompt: "--version" }), cwd);
      expect(out).not.toMatch(/^codex-cli-exec \d+\.\d+\.\d+\s*$/m);
      expect(out).not.toContain("No prompt provided via stdin");
      expect(out).toContain("turn.completed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);

  // `-i/--image` is variadic on `exec`, so without `--` the prompt is consumed
  // as another image path and Codex falls through to an empty stdin.
  maybeIt("does not let a variadic image list swallow the prompt", () => {
    const cwd = scratchDir();
    try {
      const image = path.join(cwd, "a.png");
      writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
      const out = runCodex(
        buildArgs({ sandbox: "read-only", prompt: "Reply with exactly: OK", imagePaths: [image] }),
        cwd,
      );
      expect(out).not.toContain("No prompt provided via stdin");
      expect(out).toContain("turn.completed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);

  // `codex exec resume` inherits its sandbox from user config and project trust
  // when no flag is emitted, which is workspace-write in a trusted directory.
  // These assert Codex accepts the flag in the position the builder puts it,
  // ahead of the `resume` subcommand.
  maybeIt("accepts the sandbox flag ahead of the resume subcommand", () => {
    const cwd = scratchDir();
    try {
      for (const sandbox of ["read-only", "full-auto"] as const) {
        const args = buildArgs({ sandbox, conversationId: "not-a-real-thread", prompt: "hi" });
        const out = runCodex(args, cwd);
        expect(out).not.toContain("unexpected argument");
        expect(out).not.toContain("a value is required for");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
