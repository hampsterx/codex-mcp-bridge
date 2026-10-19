import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NO_SYSTEM_CONFIG } from "../helpers/no-system-config.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIntrospectionEnv,
  buildSubprocessEnv,
  getMcpServerOverride,
} from "../../src/utils/env.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures");

/** `getMcpServerOverride` with the host's system config kept out. */
const override = (
  value?: string,
  options: Parameters<typeof getMcpServerOverride>[1] = {},
): string[] => getMcpServerOverride(value, { systemConfigPaths: NO_SYSTEM_CONFIG, ...options });
const fixtureHome = (name: string): string => join(FIXTURES, name);

describe("buildSubprocessEnv", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_BASE_URL"];
    delete process.env["OPENAI_ORG_ID"];
    delete process.env["CODEX_HOME"];
    delete process.env["CODEX_DEFAULT_MODEL"];
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("always sets NO_COLOR and FORCE_COLOR", () => {
    const env = buildSubprocessEnv();
    expect(env["NO_COLOR"]).toBe("1");
    expect(env["FORCE_COLOR"]).toBe("0");
  });

  it("includes allowed OpenAI keys", () => {
    process.env["OPENAI_API_KEY"] = "sk-test-123";
    process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
    const env = buildSubprocessEnv();
    expect(env["OPENAI_API_KEY"]).toBe("sk-test-123");
    expect(env["OPENAI_BASE_URL"]).toBe("https://api.openai.com");
  });

  it("includes system essentials", () => {
    process.env["HOME"] = "/home/test";
    process.env["PATH"] = "/usr/bin";
    const env = buildSubprocessEnv();
    expect(env["HOME"]).toBe("/home/test");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("excludes non-allowlisted vars", () => {
    process.env["SECRET_KEY"] = "should-not-appear";
    process.env["OPENAI_CUSTOM_THING"] = "also-excluded";
    const env = buildSubprocessEnv();
    expect(env["SECRET_KEY"]).toBeUndefined();
    expect(env["OPENAI_CUSTOM_THING"]).toBeUndefined();
  });

  it("skips empty values", () => {
    process.env["OPENAI_API_KEY"] = "";
    const env = buildSubprocessEnv();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
  });
});

describe("getMcpServerOverride", () => {
  const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
  const origCodexHome = process.env["CODEX_HOME"];

  afterEach(() => {
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  it("returns [] when CODEX_MCP_SERVERS=inherit", () => {
    process.env["CODEX_MCP_SERVERS"] = "inherit";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(override()).toEqual([]);
  });

  it("passes through a custom TOML value verbatim", () => {
    process.env["CODEX_MCP_SERVERS"] = "{ foo = { enabled = true } }";
    expect(override()).toEqual([
      "-c",
      "mcp_servers={ foo = { enabled = true } }",
    ]);
  });

  it("default mode: returns [] when config.toml is missing", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("does-not-exist");
    expect(override()).toEqual([]);
  });

  it("default mode: returns [] when config has no mcp_servers section", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-no-mcp");
    expect(override()).toEqual([]);
  });

  it("default mode: disables every server in a stdio-only config", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
    expect(override()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("default mode: disables every server in a mixed stdio+url config", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(override()).toEqual([
      "-c", "mcp_servers={github={enabled=false}, playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("default mode: handles hyphenated server names", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-hyphenated");
    expect(override()).toEqual([
      "-c", "mcp_servers={ck-search={enabled=false}, web-fetch={enabled=false}}",
    ]);
  });

  it("default mode: quotes TOML keys that need escaping", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-quoted");
    expect(override()).toEqual([
      "-c", 'mcp_servers={"weird.name"={enabled=false}}',
    ]);
  });

  it("default mode: throws actionable error on parse failure", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-malformed");
    expect(() => override()).toThrow(/failed to parse/);
    expect(() => override()).toThrow(/CODEX_MCP_SERVERS=inherit/);
  });

  it("empty string CODEX_MCP_SERVERS is treated as unset (default mode)", () => {
    process.env["CODEX_MCP_SERVERS"] = "";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
    expect(override()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("whitespace-only CODEX_MCP_SERVERS is treated as unset", () => {
    process.env["CODEX_MCP_SERVERS"] = "   ";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
    expect(override()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("inherit is trimmed before comparison", () => {
    process.env["CODEX_MCP_SERVERS"] = "  inherit  ";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(override()).toEqual([]);
  });

  it("INHERIT (upper-case) is treated as a server name, not a keyword", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "INHERIT";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
      // Not a configured server → unknown warn, disable all non-required.
      expect(override()).toEqual([
        "-c", "mcp_servers={github={enabled=false}, playwright={enabled=false}, serena={enabled=false}}",
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ignoring unknown MCP server 'INHERIT'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("raw TOML object escape hatch still works (first char is {)", () => {
    process.env["CODEX_MCP_SERVERS"] = "{ foo = { enabled = true } }";
    expect(override()).toEqual([
      "-c",
      "mcp_servers={ foo = { enabled = true } }",
    ]);
  });

  it("raw TOML array escape hatch (first char is [)", () => {
    process.env["CODEX_MCP_SERVERS"] = '[ "foo" ]';
    expect(override()).toEqual(["-c", 'mcp_servers=[ "foo" ]']);
  });

  it("raw TOML passthrough after leading whitespace", () => {
    process.env["CODEX_MCP_SERVERS"] = "   { foo = {} }   ";
    expect(override()).toEqual(["-c", "mcp_servers={ foo = {} }"]);
  });

  it("comma list: enables named servers, disables the rest", () => {
    process.env["CODEX_MCP_SERVERS"] = "github,serena";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(override()).toEqual([
      "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("comma list: trims whitespace around items", () => {
    process.env["CODEX_MCP_SERVERS"] = " github , serena ";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(override()).toEqual([
      "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("comma list: filters empty items", () => {
    process.env["CODEX_MCP_SERVERS"] = "github,,serena,";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(override()).toEqual([
      "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("comma list: dedupes repeated items", () => {
    process.env["CODEX_MCP_SERVERS"] = "github,github,serena";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(override()).toEqual([
      "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("comma list: warns once per unknown name, drops it silently from enable set", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "github,unknown,unknown,serena";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
      expect(override()).toEqual([
        "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
      ]);
      // Only one warning for 'unknown' despite two mentions.
      const unknownWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("'unknown'"),
      );
      expect(unknownWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("comma list: keeps required server enabled with a warning when list excludes it", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "foo";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      // Config has foo (non-req), bar (required), baz (non-req).
      // foo is in enable set → explicit enabled=true.
      // bar is required → kept enabled with warn (no explicit override emitted).
      // baz → disabled.
      expect(override()).toEqual([
        "-c", "mcp_servers={baz={enabled=false}, foo={enabled=true}}",
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("refusing to disable required MCP server 'bar'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("comma list: no warning when enable list already includes the required server", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "bar";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      expect(override()).toEqual([
        "-c", "mcp_servers={bar={enabled=true}, baz={enabled=false}, foo={enabled=false}}",
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("comma list: emits enabled=true for a requested server that config.toml disables", () => {
    // codex-home-disabled has playwright (enabled by default) and serena
    // (enabled=false). Asking for serena via the env var must emit an
    // explicit enabled=true so Codex actually turns it on rather than
    // silently dropping it.
    process.env["CODEX_MCP_SERVERS"] = "serena";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-disabled");
    expect(override()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("default mode silently keeps required servers enabled", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env["CODEX_MCP_SERVERS"];
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      expect(override()).toEqual([
        "-c", "mcp_servers={baz={enabled=false}, foo={enabled=false}}",
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("override parameter takes precedence over env var", () => {
    process.env["CODEX_MCP_SERVERS"] = "inherit";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    // Explicit override with "serena" should enable serena (not passthrough).
    expect(override("serena")).toEqual([
      "-c", "mcp_servers={github={enabled=false}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("silent:true suppresses unknown-name warnings in comma list", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
      // serena is not configured in mixed fixture? actually it is. Use a
      // fixture value that's NOT configured ('ghost') to test the unknown path.
      override("ghost,github", { silent: true });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("silent:true suppresses required-server warning in comma list", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      // foo is non-required, bar is required — asking for foo alone would
      // normally warn that bar is kept enabled.
      const args = override("foo", { silent: true });
      expect(args).toEqual([
        "-c", "mcp_servers={baz={enabled=false}, foo={enabled=true}}",
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("override parameter: empty string overrides env var to default disable-all", () => {
    process.env["CODEX_MCP_SERVERS"] = "inherit";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
    expect(override("")).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("explicit empty string env var warns when it would drop a required server", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      expect(override()).toEqual([
        "-c", "mcp_servers={baz={enabled=false}, foo={enabled=false}}",
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("refusing to disable required MCP server 'bar'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("explicit whitespace-only env var also warns about required drops", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "   ";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      override();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("refusing to disable required MCP server 'bar'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("explicit empty override parameter warns about required drops", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env["CODEX_MCP_SERVERS"];
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      expect(override("")).toEqual([
        "-c", "mcp_servers={baz={enabled=false}, foo={enabled=false}}",
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("refusing to disable required MCP server 'bar'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("silent:true suppresses required warning even on explicit empty override", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env["CODEX_MCP_SERVERS"];
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      // Tool-default path: query.ts passes "" explicitly with silent:true
      // so users who never set anything don't see warnings.
      const args = override("", { silent: true });
      expect(args).toEqual([
        "-c", "mcp_servers={baz={enabled=false}, foo={enabled=false}}",
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("getMcpServerOverride with a project .codex/config.toml", () => {
  const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
  const origCodexHome = process.env["CODEX_HOME"];
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "codex-mcp-project-"));
    mkdirSync(join(project, ".codex"));
    writeFileSync(
      join(project, ".codex", "config.toml"),
      '[mcp_servers.projfake]\ncommand = "./fake-mcp.sh"\n\n[mcp_servers.serena]\ncommand = "uv"\n',
    );
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  it("default mode: disables a server only the project declares, keeping its transport", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    // Without the transport, Codex refuses to start when the project is
    // untrusted and never loaded the server ("invalid transport").
    expect(override(undefined, { cwd: project })).toEqual([
      "-c", 'mcp_servers={playwright={enabled=false}, projfake={enabled=false, command="./fake-mcp.sh"}, serena={enabled=false}}',
    ]);
  });

  it("comma list: a project-only name is known, and left to Codex's own trust gate", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "projfake";
      expect(override(undefined, { cwd: project })).toEqual([
        "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("puts project names Codex's -c parser would split inside the value, never the key path", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    // Codex splits `-c` on the first `=` and the path on `.`, without
    // unquoting: in the key path these names stopped every call from an
    // untrusted repo, and `x={...}#` injected an enabled server.
    writeFileSync(
      join(project, ".codex", "config.toml"),
      '[mcp_servers."my.server"]\ncommand = "x"\n\n[mcp_servers."a=b"]\ncommand = "x"\n',
    );
    expect(override(undefined, { cwd: project })).toEqual([
      "-c",
      'mcp_servers={"a=b"={enabled=false, command="x"}, "my.server"={enabled=false, command="x"}, ' +
        "playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("stops the project walk at the root the user config's project_root_markers define", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/master\n");
    const sub = join(project, "sub");
    mkdirSync(join(sub, ".codex"), { recursive: true });
    writeFileSync(join(sub, ".codex", "config.toml"), '[mcp_servers.subfake]\ncommand = "s"\n');
    const home = join(project, "home");
    mkdirSync(home);
    process.env["CODEX_HOME"] = home;

    writeFileSync(join(home, "config.toml"), "");
    expect(override(undefined, { cwd: sub })[1]).toContain("projfake=");

    // An empty array disables root detection, so Codex reads only cwd.
    writeFileSync(join(home, "config.toml"), "project_root_markers = []\n");
    expect(override(undefined, { cwd: sub })).toEqual([
      "-c", 'mcp_servers={subfake={enabled=false, command="s"}}',
    ]);
  });

  it("fails closed on an unreadable project config, except under inherit, which reads nothing", () => {
    writeFileSync(join(project, ".codex", "config.toml"), "[mcp_servers.broken\n");

    delete process.env["CODEX_MCP_SERVERS"];
    expect(() => override(undefined, { cwd: project })).toThrow(/CODEX_MCP_SERVERS=inherit/);

    process.env["CODEX_MCP_SERVERS"] = "inherit";
    expect(override(undefined, { cwd: project })).toEqual([]);
  });

  it.each([
    ["a plain user server", "", undefined, 'mcp_servers={shared={enabled=false}}'],
    ["a required user server", "required = true\n", undefined, null],
    ["an explicitly enabled user server", "", "shared", 'mcp_servers={shared={enabled=true}}'],
  ])("leaves %s to the user config when project layers disagree on its transport", (_, extra, enable, expected) => {
    // User `shared`, trusted-parent `command`, ignored untrusted child `url`:
    // the project declarations of a user-declared name are never read, so
    // their conflict cannot refuse the call.
    const home = join(project, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), `[mcp_servers.shared]\ncommand = "/bin/false"\n${extra}`);
    process.env["CODEX_HOME"] = home;
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(project, ".codex", "config.toml"), '[mcp_servers.shared]\ncommand = "/bin/false"\n');
    const child = join(project, "child");
    mkdirSync(join(child, ".codex"), { recursive: true });
    writeFileSync(join(child, ".codex", "config.toml"), '[mcp_servers.shared]\nurl = "http://127.0.0.1:9/mcp"\n');
    if (enable) process.env["CODEX_MCP_SERVERS"] = enable;
    else delete process.env["CODEX_MCP_SERVERS"];

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(override(undefined, { cwd: child })).toEqual(expected === null ? [] : ["-c", expected]);
      // Also the explicit-empty path.
      expect(() => override("", { cwd: child })).not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reads servers and markers from the system config paths it is given", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    const system = join(project, "etc");
    mkdirSync(system);
    writeFileSync(
      join(system, "config.toml"),
      '[mcp_servers.sysfake]\nurl = "http://127.0.0.1:9/mcp"\n\n[mcp_servers.projfake]\nurl = "http://h"\n',
    );
    const paths = { system: join(system, "config.toml"), managed: join(system, "managed_config.toml") };

    // projfake is now system-declared, so the project's command is not re-stated.
    expect(override(undefined, { cwd: project, systemConfigPaths: paths })).toEqual([
      "-c",
      "mcp_servers={playwright={enabled=false}, projfake={enabled=false}, serena={enabled=false}, sysfake={enabled=false}}",
    ]);
    expect(override(undefined, { cwd: project, systemConfigPaths: null })[1]).not.toContain("sysfake");
  });

  it("without cwd, no project config is read", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    expect(override()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });
});

describe("getMcpServerOverride under a managed config", () => {
  const origMcpEnv = process.env["CODEX_MCP_SERVERS"];
  const origCodexHome = process.env["CODEX_HOME"];
  let dir: string;
  let paths: { system: string; managed: string };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  /** Warnings about managed config only; other warnings are not under test here. */
  const managedWarnings = (): string[] =>
    warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("managed config"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-mcp-managed-"));
    paths = { system: join(dir, "config.toml"), managed: join(dir, "managed_config.toml") };
    // User config declares playwright and serena.
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
    delete process.env["CODEX_MCP_SERVERS"];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    if (origMcpEnv === undefined) delete process.env["CODEX_MCP_SERVERS"];
    else process.env["CODEX_MCP_SERVERS"] = origMcpEnv;
    if (origCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = origCodexHome;
  });

  it("warns once, naming every server, when managed config keeps on what the bridge disables", () => {
    writeFileSync(
      paths.managed,
      "[mcp_servers.serena]\nenabled = true\n\n[mcp_servers.playwright]\nenabled = true\n",
    );
    const args = override(undefined, { systemConfigPaths: paths });

    expect(managedWarnings()).toEqual([
      expect.stringMatching(new RegExp(`managed config ${paths.managed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} keeps MCP server\\(s\\) 'playwright', 'serena' enabled`)),
    ]);
    // The warning changes nothing: same argv as with no managed config at all.
    expect(args).toEqual(override(undefined, { systemConfigPaths: NO_SYSTEM_CONFIG }));
  });

  it("warns when managed config keeps off a server the caller asked to enable", () => {
    writeFileSync(paths.managed, "[mcp_servers.serena]\nenabled = false\n");
    process.env["CODEX_MCP_SERVERS"] = "serena";
    const args = override(undefined, { systemConfigPaths: paths });

    expect(managedWarnings()).toEqual([
      expect.stringContaining("keeps MCP server(s) 'serena' disabled"),
    ]);
    expect(args).toEqual(override(undefined, { systemConfigPaths: NO_SYSTEM_CONFIG }));
    expect(args).toEqual(["-c", "mcp_servers={playwright={enabled=false}, serena={enabled=true}}"]);
  });

  it("names a server only the managed config declares", () => {
    writeFileSync(paths.managed, '[mcp_servers.mgd]\ncommand = "m"\nenabled = true\n');
    override(undefined, { systemConfigPaths: paths });
    expect(managedWarnings()).toEqual([expect.stringContaining("'mgd' enabled")]);
  });

  it("stays quiet when managed config agrees, or the server is required", () => {
    writeFileSync(
      paths.managed,
      "[mcp_servers.playwright]\nenabled = false\n\n[mcp_servers.serena]\nenabled = true\nrequired = true\n",
    );
    override(undefined, { systemConfigPaths: paths });
    process.env["CODEX_MCP_SERVERS"] = "serena";
    override(undefined, { systemConfigPaths: paths });
    expect(managedWarnings()).toEqual([]);
  });

  it("respects silent", () => {
    writeFileSync(paths.managed, "[mcp_servers.serena]\nenabled = true\n");
    override("", { silent: true, systemConfigPaths: paths });
    override("serena,playwright", { silent: true, systemConfigPaths: paths });
    expect(managedWarnings()).toEqual([]);
  });
});

describe("buildIntrospectionEnv", () => {
  const KEY = "SLACK_USER_TOKEN_TEST_FIXTURE";

  afterEach(() => {
    delete process.env[KEY];
  });

  it("passes through credentials the hardened allowlist would strip", () => {
    // Regression: MCP servers read credentials from the environment
    // (bearer_token_env_var / mcp_servers.NAME.env). Under the allowlist
    // those vanish and introspection reports a fabricated "env var not set"
    // failure for a server that is healthy in the user's own Codex.
    process.env[KEY] = "xoxp-fixture-value";
    expect(buildIntrospectionEnv()[KEY]).toBe("xoxp-fixture-value");
    expect(buildSubprocessEnv()[KEY]).toBeUndefined();
  });

  it("pins colour off even when the parent sets the opposite", () => {
    // Seeding the pins before copying process.env lets an inherited value win,
    // which puts ANSI escapes into the JSONL stream the parser reads. Asserting
    // the pins without a competing parent value cannot catch that.
    const origForce = process.env["FORCE_COLOR"];
    const origNo = process.env["NO_COLOR"];
    try {
      process.env["FORCE_COLOR"] = "1";
      process.env["NO_COLOR"] = "";
      const env = buildIntrospectionEnv();
      expect(env["NO_COLOR"]).toBe("1");
      expect(env["FORCE_COLOR"]).toBe("0");
    } finally {
      if (origForce === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = origForce;
      if (origNo === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = origNo;
    }
  });
});
