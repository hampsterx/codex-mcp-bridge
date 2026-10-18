import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIntrospectionEnv,
  buildSubprocessEnv,
  getMcpServerOverride,
} from "../../src/utils/env.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures");
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
    expect(getMcpServerOverride()).toEqual([]);
  });

  it("passes through a custom TOML value verbatim", () => {
    process.env["CODEX_MCP_SERVERS"] = "{ foo = { enabled = true } }";
    expect(getMcpServerOverride()).toEqual([
      "-c",
      "mcp_servers={ foo = { enabled = true } }",
    ]);
  });

  it("default mode: returns [] when config.toml is missing", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("does-not-exist");
    expect(getMcpServerOverride()).toEqual([]);
  });

  it("default mode: returns [] when config has no mcp_servers section", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-no-mcp");
    expect(getMcpServerOverride()).toEqual([]);
  });

  it("default mode: disables every server in a stdio-only config", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("default mode: disables every server in a mixed stdio+url config", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={github={enabled=false}, playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("default mode: handles hyphenated server names", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-hyphenated");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={ck-search={enabled=false}, web-fetch={enabled=false}}",
    ]);
  });

  it("default mode: quotes TOML keys that need escaping", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-quoted");
    expect(getMcpServerOverride()).toEqual([
      "-c", 'mcp_servers={"weird.name"={enabled=false}}',
    ]);
  });

  it("default mode: throws actionable error on parse failure", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    process.env["CODEX_HOME"] = fixtureHome("codex-home-malformed");
    expect(() => getMcpServerOverride()).toThrow(/failed to parse/);
    expect(() => getMcpServerOverride()).toThrow(/CODEX_MCP_SERVERS=inherit/);
  });

  it("empty string CODEX_MCP_SERVERS is treated as unset (default mode)", () => {
    process.env["CODEX_MCP_SERVERS"] = "";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("whitespace-only CODEX_MCP_SERVERS is treated as unset", () => {
    process.env["CODEX_MCP_SERVERS"] = "   ";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-stdio");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("inherit is trimmed before comparison", () => {
    process.env["CODEX_MCP_SERVERS"] = "  inherit  ";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(getMcpServerOverride()).toEqual([]);
  });

  it("INHERIT (upper-case) is treated as a server name, not a keyword", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "INHERIT";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
      // Not a configured server → unknown warn, disable all non-required.
      expect(getMcpServerOverride()).toEqual([
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
    expect(getMcpServerOverride()).toEqual([
      "-c",
      "mcp_servers={ foo = { enabled = true } }",
    ]);
  });

  it("raw TOML array escape hatch (first char is [)", () => {
    process.env["CODEX_MCP_SERVERS"] = '[ "foo" ]';
    expect(getMcpServerOverride()).toEqual(["-c", 'mcp_servers=[ "foo" ]']);
  });

  it("raw TOML passthrough after leading whitespace", () => {
    process.env["CODEX_MCP_SERVERS"] = "   { foo = {} }   ";
    expect(getMcpServerOverride()).toEqual(["-c", "mcp_servers={ foo = {} }"]);
  });

  it("comma list: enables named servers, disables the rest", () => {
    process.env["CODEX_MCP_SERVERS"] = "github,serena";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("comma list: trims whitespace around items", () => {
    process.env["CODEX_MCP_SERVERS"] = " github , serena ";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("comma list: filters empty items", () => {
    process.env["CODEX_MCP_SERVERS"] = "github,,serena,";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("comma list: dedupes repeated items", () => {
    process.env["CODEX_MCP_SERVERS"] = "github,github,serena";
    process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={github={enabled=true}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("comma list: warns once per unknown name, drops it silently from enable set", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "github,unknown,unknown,serena";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
      expect(getMcpServerOverride()).toEqual([
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
      expect(getMcpServerOverride()).toEqual([
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
      expect(getMcpServerOverride()).toEqual([
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
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("default mode silently keeps required servers enabled", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env["CODEX_MCP_SERVERS"];
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      expect(getMcpServerOverride()).toEqual([
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
    expect(getMcpServerOverride("serena")).toEqual([
      "-c", "mcp_servers={github={enabled=false}, playwright={enabled=false}, serena={enabled=true}}",
    ]);
  });

  it("silent:true suppresses unknown-name warnings in comma list", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_HOME"] = fixtureHome("codex-home-mixed");
      // serena is not configured in mixed fixture? actually it is. Use a
      // fixture value that's NOT configured ('ghost') to test the unknown path.
      getMcpServerOverride("ghost,github", { silent: true });
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
      const args = getMcpServerOverride("foo", { silent: true });
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
    expect(getMcpServerOverride("")).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
  });

  it("explicit empty string env var warns when it would drop a required server", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "";
      process.env["CODEX_HOME"] = fixtureHome("codex-home-required");
      expect(getMcpServerOverride()).toEqual([
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
      getMcpServerOverride();
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
      expect(getMcpServerOverride("")).toEqual([
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
      const args = getMcpServerOverride("", { silent: true });
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
    expect(getMcpServerOverride(undefined, { cwd: project })).toEqual([
      "-c", 'mcp_servers={playwright={enabled=false}, projfake={enabled=false, command="./fake-mcp.sh"}, serena={enabled=false}}',
    ]);
  });

  it("comma list: a project-only name is known, and left to Codex's own trust gate", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["CODEX_MCP_SERVERS"] = "projfake";
      expect(getMcpServerOverride(undefined, { cwd: project })).toEqual([
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
    expect(getMcpServerOverride(undefined, { cwd: project })).toEqual([
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
    expect(getMcpServerOverride(undefined, { cwd: sub })[1]).toContain("projfake=");

    // An empty array disables root detection, so Codex reads only cwd.
    writeFileSync(join(home, "config.toml"), "project_root_markers = []\n");
    expect(getMcpServerOverride(undefined, { cwd: sub })).toEqual([
      "-c", 'mcp_servers={subfake={enabled=false, command="s"}}',
    ]);
  });

  it("fails closed on an unreadable project config, except under inherit, which reads nothing", () => {
    writeFileSync(join(project, ".codex", "config.toml"), "[mcp_servers.broken\n");

    delete process.env["CODEX_MCP_SERVERS"];
    expect(() => getMcpServerOverride(undefined, { cwd: project })).toThrow(/CODEX_MCP_SERVERS=inherit/);

    process.env["CODEX_MCP_SERVERS"] = "inherit";
    expect(getMcpServerOverride(undefined, { cwd: project })).toEqual([]);
  });

  it("without cwd, only the user config is enumerated", () => {
    delete process.env["CODEX_MCP_SERVERS"];
    expect(getMcpServerOverride()).toEqual([
      "-c", "mcp_servers={playwright={enabled=false}, serena={enabled=false}}",
    ]);
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
