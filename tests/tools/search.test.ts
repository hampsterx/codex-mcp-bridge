import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";

const { spawnCodexMock, verifyDirectoryMock } = vi.hoisted(() => ({
  spawnCodexMock: vi.fn<(options: SpawnOptions) => Promise<SpawnResult>>(),
  verifyDirectoryMock: vi.fn<(dir: string) => Promise<string>>(),
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

import { executeSearch } from "../../src/tools/search.js";

const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
const origCodexHome = process.env["CODEX_HOME"];

describe("executeSearch", () => {
  beforeEach(() => {
    spawnCodexMock.mockReset();
    verifyDirectoryMock.mockReset();
    verifyDirectoryMock.mockResolvedValue("/repo");
    process.env["CODEX_MCP_SERVERS"] = "inherit";
    delete process.env["CODEX_HOME"];
  });

  afterEach(() => {
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  it("places --search before exec and uses stdin prompt", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "search response",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeSearch({
      query: "latest release notes",
      model: "o3",
      workingDirectory: "/repo",
    });

    expect(spawnCodexMock).toHaveBeenCalledTimes(1);
    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.cwd).toBe("/repo");
    expect(call.args.slice(0, 2)).toEqual(["--search", "exec"]);
    expect(call.args).toContain("--model");
    expect(call.args).toContain("o3");
    expect(call.args).toContain("--skip-git-repo-check");
    expect(call.stdin).toContain("latest release notes");
    expect(result.response).toBe("search response");
    expect(result.model).toBe("o3");
  });

  it("returns timeout response without parsing output", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });

    const result = await executeSearch({ query: "slow query", timeout: 1234 });

    expect(result.timedOut).toBe(true);
    expect(result.response).toContain("1.234s");
  });
});
