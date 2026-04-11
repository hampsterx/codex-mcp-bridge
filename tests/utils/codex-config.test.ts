import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import {
  readCodexConfig,
  listMcpServerNames,
  listMcpServers,
  buildDisableArgs,
  buildMcpArgs,
  quoteKey,
  resolveCodexConfigPath,
  type ConfiguredServer,
} from "../../src/utils/codex-config.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const fixture = (name: string): string => join(FIXTURES, name, "config.toml");

describe("readCodexConfig", () => {
  it("returns null when the file does not exist", () => {
    expect(readCodexConfig(join(FIXTURES, "does-not-exist", "config.toml"))).toBeNull();
  });

  it("parses an empty config (comments only)", () => {
    const config = readCodexConfig(fixture("codex-home-empty"));
    expect(config).not.toBeNull();
    expect(config?.mcp_servers).toBeUndefined();
  });

  it("parses a config with only top-level keys and no mcp_servers", () => {
    const config = readCodexConfig(fixture("codex-home-no-mcp"));
    expect(config?.mcp_servers).toBeUndefined();
    expect(config?.["model"]).toBe("gpt-5-codex");
  });

  it("parses stdio servers", () => {
    const config = readCodexConfig(fixture("codex-home-stdio"));
    expect(Object.keys(config?.mcp_servers ?? {})).toEqual(["playwright", "serena"]);
  });

  it("parses url-based servers", () => {
    const config = readCodexConfig(fixture("codex-home-url"));
    expect(Object.keys(config?.mcp_servers ?? {})).toEqual(["github", "atlassian"]);
  });

  it("parses mixed stdio + url servers alongside other top-level keys", () => {
    const config = readCodexConfig(fixture("codex-home-mixed"));
    expect(config?.["model"]).toBe("gpt-5-codex");
    expect(Object.keys(config?.mcp_servers ?? {}).sort()).toEqual([
      "github",
      "playwright",
      "serena",
    ]);
  });

  it("parses hyphenated server names", () => {
    const config = readCodexConfig(fixture("codex-home-hyphenated"));
    expect(Object.keys(config?.mcp_servers ?? {}).sort()).toEqual(["ck-search", "gemini-bridge"]);
  });

  it("parses quoted TOML keys with dots", () => {
    const config = readCodexConfig(fixture("codex-home-quoted"));
    expect(Object.keys(config?.mcp_servers ?? {})).toEqual(["weird.name"]);
  });

  it("throws an actionable error on malformed TOML", () => {
    expect(() => readCodexConfig(fixture("codex-home-malformed"))).toThrow(/failed to parse/);
    expect(() => readCodexConfig(fixture("codex-home-malformed"))).toThrow(/CODEX_MCP_SERVERS=inherit/);
  });
});

describe("listMcpServerNames", () => {
  it("returns an empty array when config is null", () => {
    expect(listMcpServerNames(null)).toEqual([]);
  });

  it("returns an empty array when mcp_servers is missing", () => {
    expect(listMcpServerNames({})).toEqual([]);
  });

  it("returns names sorted lexicographically", () => {
    const config = readCodexConfig(fixture("codex-home-mixed"));
    expect(listMcpServerNames(config)).toEqual(["github", "playwright", "serena"]);
  });

  it("handles hyphenated names", () => {
    const config = readCodexConfig(fixture("codex-home-hyphenated"));
    expect(listMcpServerNames(config)).toEqual(["ck-search", "gemini-bridge"]);
  });

  it("handles quoted keys", () => {
    const config = readCodexConfig(fixture("codex-home-quoted"));
    expect(listMcpServerNames(config)).toEqual(["weird.name"]);
  });
});

describe("quoteKey", () => {
  it("leaves simple bare keys unquoted", () => {
    expect(quoteKey("playwright")).toBe("playwright");
    expect(quoteKey("ck-search")).toBe("ck-search");
    expect(quoteKey("my_server_1")).toBe("my_server_1");
  });

  it("quotes keys containing non-bare characters", () => {
    expect(quoteKey("weird.name")).toBe('"weird.name"');
    expect(quoteKey("with space")).toBe('"with space"');
  });

  it("escapes embedded quotes and backslashes", () => {
    expect(quoteKey('has"quote')).toBe('"has\\"quote"');
    expect(quoteKey("has\\backslash")).toBe('"has\\\\backslash"');
  });
});

describe("buildDisableArgs", () => {
  it("returns [] for an empty list", () => {
    expect(buildDisableArgs([])).toEqual([]);
  });

  it("emits a stable sorted sequence of -c entries", () => {
    expect(buildDisableArgs(["serena", "playwright", "github"])).toEqual([
      "-c", "mcp_servers.github.enabled=false",
      "-c", "mcp_servers.playwright.enabled=false",
      "-c", "mcp_servers.serena.enabled=false",
    ]);
  });

  it("quotes names that are not bare TOML keys", () => {
    expect(buildDisableArgs(["weird.name", "ck-search"])).toEqual([
      "-c", "mcp_servers.ck-search.enabled=false",
      "-c", 'mcp_servers."weird.name".enabled=false',
    ]);
  });

  it("respects an optional except to keep one server enabled", () => {
    expect(buildDisableArgs(["github", "playwright", "serena"], "serena")).toEqual([
      "-c", "mcp_servers.github.enabled=false",
      "-c", "mcp_servers.playwright.enabled=false",
    ]);
  });
});

describe("listMcpServers", () => {
  it("returns [] when config is null", () => {
    expect(listMcpServers(null)).toEqual([]);
  });

  it("returns [] when mcp_servers is missing", () => {
    expect(listMcpServers({})).toEqual([]);
  });

  it("returns required=false for servers without the flag", () => {
    const config = readCodexConfig(fixture("codex-home-mixed"));
    expect(listMcpServers(config)).toEqual([
      { name: "github", required: false },
      { name: "playwright", required: false },
      { name: "serena", required: false },
    ]);
  });

  it("reads required=true from config.toml", () => {
    const config = readCodexConfig(fixture("codex-home-required"));
    expect(listMcpServers(config)).toEqual([
      { name: "bar", required: true },
      { name: "baz", required: false },
      { name: "foo", required: false },
    ]);
  });
});

describe("buildMcpArgs", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const configured: ConfiguredServer[] = [
    { name: "foo", required: false },
    { name: "bar", required: true },
    { name: "baz", required: false },
  ];

  it("returns [] for an empty configured list", () => {
    expect(buildMcpArgs([])).toEqual([]);
  });

  it("disables all non-required when enabled is undefined (default disable-all)", () => {
    expect(buildMcpArgs(configured)).toEqual([
      "-c", "mcp_servers.baz.enabled=false",
      "-c", "mcp_servers.foo.enabled=false",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("disables all non-required when enabled is empty set", () => {
    expect(buildMcpArgs(configured, new Set())).toEqual([
      "-c", "mcp_servers.baz.enabled=false",
      "-c", "mcp_servers.foo.enabled=false",
    ]);
  });

  it("keeps required server enabled even without warning in default mode", () => {
    // required=bar, enabled=undefined → silent keep
    expect(buildMcpArgs(configured)).not.toContain("mcp_servers.bar.enabled=false");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns loudly when explicit enable list would drop a required server", () => {
    const args = buildMcpArgs(configured, new Set(["foo"]));
    expect(args).toEqual([
      "-c", "mcp_servers.baz.enabled=false",
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/refusing to disable required MCP server 'bar'/);
  });

  it("silent:true suppresses the required-server warning", () => {
    const args = buildMcpArgs(configured, new Set(["foo"]), { silent: true });
    expect(args).toEqual([
      "-c", "mcp_servers.baz.enabled=false",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when required server is already in enable set", () => {
    const args = buildMcpArgs(configured, new Set(["bar"]));
    expect(args).toEqual([
      "-c", "mcp_servers.baz.enabled=false",
      "-c", "mcp_servers.foo.enabled=false",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("quotes non-bare TOML keys", () => {
    const args = buildMcpArgs(
      [{ name: "weird.name", required: false }, { name: "ck-search", required: false }],
    );
    expect(args).toEqual([
      "-c", "mcp_servers.ck-search.enabled=false",
      "-c", 'mcp_servers."weird.name".enabled=false',
    ]);
  });
});

describe("resolveCodexConfigPath", () => {
  it("honors CODEX_HOME when set", () => {
    const orig = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = "/tmp/alt-codex";
    try {
      expect(resolveCodexConfigPath()).toBe("/tmp/alt-codex/config.toml");
    } finally {
      if (orig === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = orig;
    }
  });

  it("falls back to ~/.codex/config.toml when CODEX_HOME is unset", () => {
    const orig = process.env["CODEX_HOME"];
    delete process.env["CODEX_HOME"];
    try {
      const path = resolveCodexConfigPath();
      expect(path.endsWith("/.codex/config.toml")).toBe(true);
    } finally {
      if (orig !== undefined) process.env["CODEX_HOME"] = orig;
    }
  });
});
