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

vi.mock("../../src/utils/git.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/git.js")>("../../src/utils/git.js");
  return {
    ...actual,
    getGitRoot: getGitRootMock,
    getUncommittedDiff: getUncommittedDiffMock,
    getBranchDiff: getBranchDiffMock,
    getDiffStat: getDiffStatMock,
  };
});

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
    getDiffStatMock.mockReset();

    verifyDirectoryMock.mockResolvedValue("/repo/requested");
    getGitRootMock.mockReturnValue("/repo/root");
    getDiffStatMock.mockReturnValue(undefined);

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
    expect(result.mode).toBe("deep");
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
    expect(result.mode).toBe("scan");
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
    // serena explicitly enabled (so config.toml enabled=false would still be
    // overridden), github + playwright disabled.
    expect(call.args).toEqual([
      "exec",
      "-c", "mcp_servers.github.enabled=false",
      "-c", "mcp_servers.playwright.enabled=false",
      "-c", "mcp_servers.serena.enabled=true",
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
      "-c", "mcp_servers.github.enabled=true",
      "-c", "mcp_servers.playwright.enabled=false",
      "-c", "mcp_servers.serena.enabled=false",
      "--model", "o3",
      "--full-auto",
      "--skip-git-repo-check",
    ]);
  });

  it("agentic default with serena configured loads the serena-aware prompt", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "ok", stderr: "", exitCode: 0, timedOut: false,
    });

    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-mixed");

    await executeReview({ quick: false, uncommitted: true, model: "o3" });

    const call = spawnCodexMock.mock.calls[0]![0];
    // Distinctive markers from review-agentic-with-serena.md
    expect(call.stdin).toContain("Serena");
    expect(call.stdin).toContain("get_symbols_overview");
    expect(call.stdin).toContain("find_referencing_symbols");
  });

  it("agentic with mcpServers=\"\" loads the generic prompt (no serena markers)", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "ok", stderr: "", exitCode: 0, timedOut: false,
    });

    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-mixed");

    await executeReview({
      quick: false,
      uncommitted: true,
      model: "o3",
      mcpServers: "",
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.stdin).not.toContain("get_symbols_overview");
    expect(call.stdin).not.toContain("find_referencing_symbols");
    // Generic prompt tells the reviewer to read full file contents.
    expect(call.stdin).toContain("Read the FULL contents");
  });

  it("agentic default with no serena in config uses the generic prompt", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    spawnCodexMock.mockResolvedValue({
      stdout: "ok", stderr: "", exitCode: 0, timedOut: false,
    });

    delete process.env["CODEX_MCP_SERVERS"];
    // codex-home-url has no serena; agentic default would ask for serena but
    // willEnableServer should report false, so generic prompt loads.
    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-url");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await executeReview({ quick: false, uncommitted: true, model: "o3" });
    } finally {
      warnSpy.mockRestore();
    }

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.stdin).not.toContain("get_symbols_overview");
    expect(call.stdin).toContain("Read the FULL contents");
  });

  it("returns early when agentic review has no uncommitted changes", async () => {
    getUncommittedDiffMock.mockImplementation(() => {
      throw new Error("No uncommitted changes found");
    });

    const result = await executeReview({
      quick: false,
      uncommitted: true,
    });

    expect(spawnCodexMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("deep");
    expect(result.response).toBe("No uncommitted changes found");
  });

  it("returns early when agentic branch review has no diff", async () => {
    getBranchDiffMock.mockImplementation(() => {
      throw new Error("No diff found between main and HEAD");
    });

    const result = await executeReview({
      quick: false,
      base: "main",
    });

    expect(spawnCodexMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("deep");
    expect(result.response).toBe("No diff found between main and HEAD");
    expect(result.diffSource).toBe("branch");
  });

  it("returns early when quick branch review has no diff", async () => {
    getBranchDiffMock.mockImplementation(() => {
      throw new Error("No diff found between main and HEAD");
    });

    const result = await executeReview({
      quick: true,
      base: "main",
    });

    expect(spawnCodexMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("scan");
    expect(result.response).toBe("No diff found between main and HEAD");
    expect(result.diffSource).toBe("branch");
  });

  it("uses base branch when both uncommitted and base are provided", async () => {
    getBranchDiffMock.mockReturnValue("diff --git a/z b/z");
    spawnCodexMock.mockResolvedValue({
      stdout: "branch review",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeReview({
      quick: true,
      uncommitted: true,
      base: "develop",
      model: "o3",
    });

    // base takes precedence over uncommitted
    expect(getBranchDiffMock).toHaveBeenCalled();
    expect(getUncommittedDiffMock).not.toHaveBeenCalled();
    expect(result.diffSource).toBe("branch");
    expect(result.base).toBe("develop");
  });

  it("rejects base ref starting with dash", async () => {
    await expect(
      executeReview({ quick: true, base: "--option", model: "o3" }),
    ).rejects.toThrow("must not start with -");
  });

  it("rejects base ref with invalid characters", async () => {
    await expect(
      executeReview({ quick: true, base: "main;rm -rf", model: "o3" }),
    ).rejects.toThrow("must be a valid git ref");
  });

  it("throws when neither uncommitted nor base is specified", async () => {
    await expect(
      executeReview({ quick: false, uncommitted: false }),
    ).rejects.toThrow("Either 'uncommitted' must be true or 'base' must be specified");
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
    expect(result.mode).toBe("scan");
    expect(result.diffSource).toBe("branch");
    expect(result.base).toBe("main");
    expect(result.model).toBe("o3");
  });
});

describe("review depth tiers", () => {
  beforeEach(() => {
    spawnCodexMock.mockReset();
    verifyDirectoryMock.mockReset();
    getGitRootMock.mockReset();
    getUncommittedDiffMock.mockReset();
    getBranchDiffMock.mockReset();
    getDiffStatMock.mockReset();

    verifyDirectoryMock.mockResolvedValue("/repo/requested");
    getGitRootMock.mockReturnValue("/repo/root");
    getDiffStatMock.mockReturnValue(undefined);

    process.env["CODEX_MCP_SERVERS"] = "inherit";
    delete process.env["CODEX_HOME"];
  });

  afterEach(() => {
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  const okSpawn = () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "review findings",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  };

  it("depth=scan uses scan timeout and read-only sandbox args (no --full-auto)", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();

    const result = await executeReview({ depth: "scan", uncommitted: true, model: "o3" });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args).toEqual(["exec", "--model", "o3", "--sandbox", "read-only", "--skip-git-repo-check"]);
    expect(call.args).not.toContain("--full-auto");
    expect(call.args).not.toContain("--ephemeral");
    expect(call.stdin).toContain("diff --git a/x b/x");
    expect(result.mode).toBe("scan");
    expect(result.appliedTimeout).toBe(120_000);
    expect(result.timeoutScaled).toBe(false);
  });

  it("depth=focused stacks --sandbox read-only + --skip-git-repo-check + --ephemeral, no --full-auto", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();

    const result = await executeReview({ depth: "focused", uncommitted: true, model: "o3" });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args).toEqual([
      "exec", "--model", "o3", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
    ]);
    expect(call.args).not.toContain("--full-auto");
    // Uses the focused prompt (inlined diff + read-changed-files instruction)
    expect(call.stdin).toContain("Read the FULL contents");
    expect(call.stdin).toContain("diff --git a/x b/x");
    expect(result.mode).toBe("focused");
  });

  it("depth=deep uses --full-auto --skip-git-repo-check (no --sandbox, no --ephemeral)", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();

    const result = await executeReview({ depth: "deep", uncommitted: true, model: "o3" });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.args).toEqual(["exec", "--model", "o3", "--full-auto", "--skip-git-repo-check"]);
    expect(call.args).not.toContain("--ephemeral");
    expect(call.args).not.toContain("--sandbox");
    // Deep mode passes only the diff spec, not the pre-inlined diff
    expect(call.stdin).toContain("git diff HEAD -U5");
    expect(result.mode).toBe("deep");
  });

  it("quick:true is equivalent to depth:scan (legacy alias)", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();

    const [scanResult] = await Promise.all([
      executeReview({ depth: "scan", uncommitted: true, model: "o3" }),
    ]);
    spawnCodexMock.mockClear();
    const [legacyResult] = await Promise.all([
      executeReview({ quick: true, uncommitted: true, model: "o3" }),
    ]);

    expect(scanResult.mode).toBe("scan");
    expect(legacyResult.mode).toBe("scan");
    expect(legacyResult.appliedTimeout).toBe(scanResult.appliedTimeout);
  });

  it("quick:false (no depth) defaults to depth:deep", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();

    const result = await executeReview({ quick: false, uncommitted: true });

    expect(result.mode).toBe("deep");
  });

  it("depth wins over quick when both are set (logs deprecation)", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await executeReview({ depth: "focused", quick: true, uncommitted: true });

    expect(result.mode).toBe("focused");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/'quick' is deprecated.*depth="focused"/),
    );
    warnSpy.mockRestore();
  });

  it("focused falls back to 240s when diffStat is unavailable", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue(undefined);
    okSpawn();

    const result = await executeReview({ depth: "focused", uncommitted: true });

    expect(result.appliedTimeout).toBe(240_000);
    expect(result.timeoutScaled).toBe(false);
  });

  it("focused scales timeout with file count, capped at 300s", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 4, insertions: 40, deletions: 20 });
    okSpawn();

    const result = await executeReview({ depth: "focused", uncommitted: true });

    // 120 + 15 * 4 = 180s
    expect(result.appliedTimeout).toBe(180_000);
    expect(result.timeoutScaled).toBe(true);
  });

  it("CODEX_REVIEW_FOCUSED_BASE_MS env override is honoured", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 2, insertions: 20, deletions: 5 });
    okSpawn();

    process.env["CODEX_REVIEW_FOCUSED_BASE_MS"] = "60000";
    try {
      const result = await executeReview({ depth: "focused", uncommitted: true });
      // 60 + 15 * 2 = 90s
      expect(result.appliedTimeout).toBe(90_000);
    } finally {
      delete process.env["CODEX_REVIEW_FOCUSED_BASE_MS"];
    }
  });

  it("no-diff early exit for focused does not spawn CLI", async () => {
    getUncommittedDiffMock.mockImplementation(() => {
      throw new Error("No uncommitted changes found");
    });

    const result = await executeReview({ depth: "focused", uncommitted: true });

    expect(spawnCodexMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("focused");
    expect(result.response).toBe("No uncommitted changes found");
  });

  it("focused large-diff warning attached when +/- total exceeds threshold", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 8, insertions: 800, deletions: 400 });
    okSpawn();

    const result = await executeReview({ depth: "focused", uncommitted: true });

    expect(result.response).toContain("large diff");
    expect(result.response).toContain(`depth: "deep"`);
  });

  it("focused small-diff does not attach large-diff warning", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    getDiffStatMock.mockReturnValue({ files: 2, insertions: 20, deletions: 10 });
    okSpawn();

    const result = await executeReview({ depth: "focused", uncommitted: true });

    expect(result.response).not.toContain("large diff");
  });

  it("explicit mcpServers wins over per-depth default", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();
    delete process.env["CODEX_MCP_SERVERS"];
    // Use an empty config (no servers configured) so "serena" is unknown and drops
    // silently; we only care that the prompt selection reflects the override.
    process.env["CODEX_HOME"] = join(FIXTURES, "codex-home-empty");

    const result = await executeReview({
      depth: "deep",
      uncommitted: true,
      mcpServers: "", // explicit empty → disable-all, no serena prompt
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    // Deep mode with no serena → generic agentic prompt (not the "Use Serena" variant)
    expect(call.stdin).not.toContain("get_symbols_overview");
    expect(result.mode).toBe("deep");
  });

  it("focused maxResponseLength propagates into the prompt", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();

    await executeReview({ depth: "focused", uncommitted: true, maxResponseLength: 250 });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.stdin).toMatch(/250 words/);
  });

  it("focused focus section propagates into the prompt", async () => {
    getUncommittedDiffMock.mockReturnValue("diff --git a/x b/x");
    okSpawn();

    await executeReview({ depth: "focused", uncommitted: true, focus: "concurrency" });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.stdin).toContain("Pay special attention to: concurrency");
  });
});
