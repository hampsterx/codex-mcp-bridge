import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function runCodex(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("codex", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
      env: env ?? process.env,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

function scratchDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codex-argv-"));
}

/**
 * A throwaway `CODEX_HOME` carrying the config that defeats the sandbox.
 *
 * Without this the enforcement test below is only as good as whoever's machine
 * runs it: on a config with the default `approvals_reviewer = "user"` an
 * escalation is refused anyway, so the test passes with or without the pin and
 * guards nothing. Writing the hostile value here makes the test discriminating
 * everywhere, CI included.
 *
 * Auth is copied in because the run needs real credentials to reach a model.
 */
function hostileCodexHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  writeFileSync(path.join(home, "config.toml"), 'approvals_reviewer = "auto_review"\n');
  const realHome = process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
  copyFileSync(path.join(realHome, "auth.json"), path.join(home, "auth.json"));
  return home;
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

  // The tests above prove Codex *accepts* the level. This one proves the level
  // still means something, which is a different claim and the one that failed:
  // with `approvals_reviewer = "auto_review"`, a read-only turn escalated past
  // the flag and wrote the file, because escalation approval had been handed to
  // a model and `exec` has no human to refuse it.
  //
  // The config is built here rather than inherited, so the test fails if the
  // pin is removed no matter whose machine it runs on. Asking for a shell
  // command rather than a file edit keeps it on one mechanism: both routes
  // escaped before the fix, but the shell one reports a clean
  // `Read-only file system` when the sandbox holds.
  maybeIt("holds read-only against a config that would escalate past it", () => {
    const cwd = scratchDir();
    const home = hostileCodexHome();
    const target = path.join(cwd, "written.txt");
    // `getMcpServerOverride()` enumerates servers from the ambient config and
    // emits a `-c` disable for each. Those names do not exist in the temp home,
    // and Codex rejects the resulting config before it ever starts a turn.
    // `inherit` emits no override at all, which is what this test wants: the
    // temp home configures no servers in the first place.
    const priorMcpEnv = process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_MCP_SERVERS"] = "inherit";
    try {
      const args = buildArgs({
        sandbox: "read-only",
        prompt: `Run exactly this shell command: echo WROTE > ${target}`,
      });
      const out = runCodex(args, cwd, { ...process.env, CODEX_HOME: home });
      // Guards the guard: a config Codex refused to load would also produce no
      // file, and would pass the assertion below while testing nothing.
      expect(out).toContain("turn.completed");
      expect(out).not.toContain("Error loading config.toml");
      expect(existsSync(target)).toBe(false);
    } finally {
      if (priorMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
      else process.env["CODEX_MCP_SERVERS"] = priorMcpEnv;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
