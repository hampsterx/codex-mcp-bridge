import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_CODEX_HOME, withoutHostSystemConfig } from "../helpers/no-system-config.js";
import type { SpawnOptions, SpawnResult } from "../../src/utils/spawn.js";

const { spawnCodexMock, verifyDirectoryMock, readFilesMock } = vi.hoisted(() => ({
  spawnCodexMock: vi.fn<(options: SpawnOptions) => Promise<SpawnResult>>(),
  verifyDirectoryMock: vi.fn<(dir: string) => Promise<string>>(),
  readFilesMock: vi.fn<(files: string[], rootDir: string) => Promise<Array<{ path: string; content: string; skipped?: string }>>>(),
}));

vi.mock("../../src/utils/env.js", async (importOriginal) =>
  withoutHostSystemConfig(await importOriginal<typeof import("../../src/utils/env.js")>()),
);

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

vi.mock("../../src/utils/files.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/files.js")>("../../src/utils/files.js");
  return {
    ...actual,
    readFiles: readFilesMock,
  };
});

import { executeStructured } from "../../src/tools/structured.js";

const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
const origCodexHome = process.env["CODEX_HOME"];

describe("executeStructured", () => {
  beforeEach(() => {
    spawnCodexMock.mockReset();
    verifyDirectoryMock.mockReset();
    readFilesMock.mockReset();
    verifyDirectoryMock.mockResolvedValue("/repo");
    readFilesMock.mockResolvedValue([]);
    process.env["CODEX_MCP_SERVERS"] = "inherit";
    process.env["CODEX_HOME"] = NO_CODEX_HOME;
  });

  afterEach(() => {
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  it("returns validated JSON output", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: '{"answer":"ok"}',
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeStructured({
      prompt: "Extract answer",
      schema: JSON.stringify({
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      }),
      model: "o3",
      workingDirectory: "/repo",
    });

    const call = spawnCodexMock.mock.calls[0]![0];
    expect(call.cwd).toBe("/repo");
    expect(call.args.slice(0, 7)).toEqual([
      "exec",
      "--model=o3",
      "--sandbox",
      "read-only",
      "-c",
      'approvals_reviewer="user"',
      "--skip-git-repo-check",
    ]);
    // Positional indices would shift the moment the structured path gains a
    // default MCP override, so anchor on the separator instead.
    const sep = call.args.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(call.args[sep + 1]).toContain("Extract answer");
    expect(call.args).toHaveLength(sep + 2);
    expect(call.stdin).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(JSON.parse(result.response) as { answer: string }).toEqual({ answer: "ok" });
  });

  it("reports invalid model JSON against schema", async () => {
    spawnCodexMock.mockResolvedValue({
      stdout: '{"wrong":"shape"}',
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const result = await executeStructured({
      prompt: "Extract answer",
      schema: JSON.stringify({
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      }),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("required property");
  });

  it("rejects image files before spawning Codex", async () => {
    await expect(executeStructured({
      prompt: "Extract answer",
      schema: JSON.stringify({ type: "object" }),
      files: ["diagram.png"],
    })).rejects.toThrow("does not support image files");

    expect(spawnCodexMock).not.toHaveBeenCalled();
  });
});

describe("executeStructured MCP suppression", () => {
  const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
  const origCodexHome = process.env["CODEX_HOME"];
  let project: string;

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "codex-structured-project-")));
    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".codex", "config.toml"), '[mcp_servers.projfake]\ncommand = "./fake-mcp.sh"\n');
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = join(project, "no-codex-home");
    verifyDirectoryMock.mockResolvedValue(project);
    readFilesMock.mockResolvedValue([]);
    spawnCodexMock.mockReset();
    spawnCodexMock.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  it("disables servers from the workingDirectory's own .codex/config.toml", async () => {
    // Only the spawn is under test; the result may not parse.
    await executeStructured({ prompt: "p", schema: JSON.stringify({ type: "object" }), workingDirectory: project }).catch(() => undefined);

    const { args, cwd } = spawnCodexMock.mock.calls[0]![0];
    expect(cwd).toBe(project);
    expect(args).toContain('mcp_servers={projfake={enabled=false, command="./fake-mcp.sh"}}');
  });
});
