import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  readCodexConfig,
  listMcpServerNames,
  listMcpServers,
  buildMcpArgs,
  quoteKey,
  resolveCodexConfigPath,
  type ConfiguredServer,
  listMcpServerEnvValues,
  listProjectMcpServers,
  mergeProjectServers,
  MAX_PROJECT_CONFIG_BYTES,
  projectRootMarkers,
  effectiveProjectRootMarkers,
  findProjectRoot,
  expandHome,
  readNonProjectLayers,
  listNonProjectMcpServers,
  markersFromLayers,
  MAX_OVERRIDE_ARG_BYTES,
  readProjectConfigText,
  tomlString,
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
    expect(Object.keys(config?.mcp_servers ?? {}).sort()).toEqual(["ck-search", "web-fetch"]);
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

describe("readCodexConfig with a byte order mark", () => {
  it("parses a BOM-prefixed user config", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-config-bom-"));
    try {
      writeFileSync(join(dir, "config.toml"), '\uFEFF[mcp_servers.u]\ncommand = "x"\n');
      expect(listMcpServerNames(readCodexConfig(join(dir, "config.toml")))).toEqual(["u"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("user and system config readers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-config-bigint-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses them in the user config, which Codex accepts", () => {
    writeFileSync(join(dir, "config.toml"), '[mcp_servers.u]\ncommand = "x"\nstartup_timeout_ms = 9007199254740992\n');
    expect(listMcpServerNames(readCodexConfig(join(dir, "config.toml")))).toEqual(["u"]);
  });

  it("parses them in the system config", () => {
    const paths = { system: join(dir, "config.toml"), managed: join(dir, "managed_config.toml") };
    writeFileSync(paths.system, '[mcp_servers.sys]\ncommand = "x"\nstartup_timeout_ms = 9007199254740992\n');
    expect(listNonProjectMcpServers(readNonProjectLayers(null, paths)).map((s) => s.name)).toEqual(["sys"]);
  });

  it("reads a system config that starts with a UTF-8 byte order mark", () => {
    const paths = { system: join(dir, "config.toml"), managed: join(dir, "managed_config.toml") };
    writeFileSync(paths.system, '\uFEFF[mcp_servers.sys]\ncommand = "x"\n');
    expect(listNonProjectMcpServers(readNonProjectLayers(null, paths)).map((s) => s.name)).toEqual(["sys"]);
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
    expect(listMcpServerNames(config)).toEqual(["ck-search", "web-fetch"]);
  });

  it("handles quoted keys", () => {
    const config = readCodexConfig(fixture("codex-home-quoted"));
    expect(listMcpServerNames(config)).toEqual(["weird.name"]);
  });

  it("returns [] when mcp_servers is an array (not a table)", () => {
    // Guard against a malformed config like `mcp_servers = ["serena"]`.
    // `typeof [] === "object"` so without an Array.isArray check the bridge
    // would treat array indices as server names and emit bogus overrides.
    expect(listMcpServerNames({ mcp_servers: ["serena"] as unknown as Record<string, unknown> })).toEqual([]);
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

describe("listMcpServers", () => {
  it("returns [] when config is null", () => {
    expect(listMcpServers(null)).toEqual([]);
  });

  it("returns [] when mcp_servers is missing", () => {
    expect(listMcpServers({})).toEqual([]);
  });

  it("returns [] when mcp_servers is an array (not a table)", () => {
    expect(
      listMcpServers({ mcp_servers: ["serena"] as unknown as Record<string, unknown> }),
    ).toEqual([]);
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
      "-c", "mcp_servers={baz={enabled=false}, foo={enabled=false}}",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("disables all non-required when enabled is empty set", () => {
    expect(buildMcpArgs(configured, new Set())).toEqual([
      "-c", "mcp_servers={baz={enabled=false}, foo={enabled=false}}",
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
      "-c", "mcp_servers={baz={enabled=false}, foo={enabled=true}}",
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/refusing to disable required MCP server 'bar'/);
  });

  it("silent:true suppresses the required-server warning", () => {
    const args = buildMcpArgs(configured, new Set(["foo"]), { silent: true });
    expect(args).toEqual([
      "-c", "mcp_servers={baz={enabled=false}, foo={enabled=true}}",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when required server is already in enable set", () => {
    const args = buildMcpArgs(configured, new Set(["bar"]));
    expect(args).toEqual([
      "-c", "mcp_servers={bar={enabled=true}, baz={enabled=false}, foo={enabled=false}}",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits enabled=true for every requested server (overrides config.toml enabled=false)", () => {
    // Regression: without the explicit enabled=true override, a caller asking
    // for a server that happens to be enabled=false in config.toml would
    // silently get it disabled while willEnableServer reports it enabled.
    const args = buildMcpArgs(configured, new Set(["foo", "baz"]));
    expect(args).toEqual([
      "-c", "mcp_servers={baz={enabled=true}, foo={enabled=true}}",
    ]);
  });

  it("quotes non-bare TOML keys for both enable and disable overrides", () => {
    const args = buildMcpArgs(
      [{ name: "weird.name", required: false }, { name: "ck-search", required: false }],
      new Set(["weird.name"]),
    );
    expect(args).toEqual([
      "-c", 'mcp_servers={ck-search={enabled=false}, "weird.name"={enabled=true}}',
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

describe("listMcpServerEnvValues", () => {
  it("collects literal values from every server's env table", () => {
    const values = listMcpServerEnvValues({
      mcp_servers: {
        a: { command: "x", env: { TOKEN: "secret-a", OTHER: "plain-a" } },
        b: { command: "y", env: { KEY: "secret-b" } },
        c: { command: "z" },
      },
    });
    expect(values.sort()).toEqual(["plain-a", "secret-a", "secret-b"]);
  });

  it("returns empty for missing, malformed, or env-less config", () => {
    expect(listMcpServerEnvValues(null)).toEqual([]);
    expect(listMcpServerEnvValues({})).toEqual([]);
    expect(listMcpServerEnvValues({ mcp_servers: { a: { env: "nope" } } })).toEqual([]);
    expect(listMcpServerEnvValues({ mcp_servers: { a: { env: { N: 5 } } } })).toEqual([]);
  });
});

describe("listProjectMcpServers", () => {
  let root: string;

  const writeProjectConfig = (dir: string, toml: string): void => {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "config.toml"), toml);
  };

  /** Make `dir` a project root the way a real checkout is: `.git/HEAD`. */
  const markRoot = (dir: string): void => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
  };

  const noUserConfig = (): string => join(root, "home", "config.toml");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-config-project-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds servers in .codex/config.toml at and above cwd, with their transport", () => {
    markRoot(root);
    writeProjectConfig(root, '[mcp_servers.outer]\nurl = "http://127.0.0.1:1/mcp"\n');
    const cwd = join(root, "repo", "sub");
    mkdirSync(cwd, { recursive: true });
    writeProjectConfig(join(root, "repo"), '[mcp_servers.inner]\ncommand = "./serve.sh"\nrequired = true\n');

    expect(listProjectMcpServers(cwd, join(root, "home", "config.toml"))).toEqual([
      // A project's required = true never exempts a server: only a user, system or managed config's does.
      { name: "inner", required: false, projectTransport: { key: "command", value: "./serve.sh" } },
      { name: "outer", required: false, projectTransport: { key: "url", value: "http://127.0.0.1:1/mcp" } },
    ]);
  });

  it("takes the transport nearest cwd when the layers agree on its kind", () => {
    markRoot(root);
    writeProjectConfig(root, '[mcp_servers.dup]\ncommand = "far"\n');
    const cwd = join(root, "repo");
    writeProjectConfig(cwd, '[mcp_servers.dup]\ncommand = "near"\n');

    expect(listProjectMcpServers(cwd, join(root, "home", "config.toml"))).toEqual([
      { name: "dup", required: false, projectTransport: { key: "command", value: "near" } },
    ]);
  });

  it.each([
    ["url above, command below", 'url = "http://far"', 'command = "near"'],
    ["command above, url below", 'command = "far"', 'url = "http://near"'],
  ])("fails closed, naming both files, when layers disagree on the transport kind (%s)", (_, far, near) => {
    markRoot(root);
    writeProjectConfig(root, `[mcp_servers.shared]\n${far}\n`);
    const cwd = join(root, "repo");
    writeProjectConfig(cwd, `[mcp_servers.shared]\n${near}\n`);

    let message = "";
    try {
      listProjectMcpServers(cwd, join(root, "home", "config.toml"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(join(cwd, ".codex", "config.toml"));
    expect(message).toContain(join(root, ".codex", "config.toml"));
    expect(message).toContain("'shared'");
    expect(message).toContain("CODEX_MCP_SERVERS=inherit");
  });

  it("skips the user config when the walk reaches it", () => {
    writeProjectConfig(root, '[mcp_servers.user_only]\ncommand = "x"\n');
    expect(listProjectMcpServers(root, join(root, ".codex", "config.toml"))).toEqual([]);
  });

  it("walks from the symlink target, which is the cwd Codex sees", () => {
    const real = join(root, "real", "proj");
    mkdirSync(real, { recursive: true });
    markRoot(join(root, "real"));
    writeProjectConfig(join(root, "real"), '[mcp_servers.via_target]\ncommand = "x"\n');
    const link = join(root, "link");
    symlinkSync(real, link);

    const names = listProjectMcpServers(link, noUserConfig()).map((s) => s.name);
    expect(names).toEqual(["via_target"]);
  });

  it("stops at the project root: a file above it cannot mark a server required", () => {
    // `root` stands in for a world-writable /tmp over a checkout in it.
    writeProjectConfig(root, '[mcp_servers.foo]\ncommand = "far"\nrequired = true\n\n[mcp_servers.above]\ncommand = "x"\n');
    const repo = join(root, "repo");
    markRoot(repo);
    writeProjectConfig(repo, '[mcp_servers.foo]\ncommand = "near"\n');
    const cwd = join(repo, "sub");
    mkdirSync(cwd);

    expect(listProjectMcpServers(cwd, noUserConfig())).toEqual([
      { name: "foo", required: false, projectTransport: { key: "command", value: "near" } },
    ]);
  });

  it("treats a linked worktree's .git file as the root", () => {
    writeProjectConfig(root, '[mcp_servers.foo]\ncommand = "far"\nrequired = true\n');
    const worktree = join(root, "wt");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    writeProjectConfig(worktree, '[mcp_servers.foo]\ncommand = "near"\n');

    expect(listProjectMcpServers(worktree, noUserConfig())).toEqual([
      { name: "foo", required: false, projectTransport: { key: "command", value: "near" } },
    ]);
  });

  it("skips a .git directory with no HEAD, as Codex does, and reads up to the real root", () => {
    markRoot(root);
    writeProjectConfig(root, '[mcp_servers.outer]\ncommand = "x"\n');
    const cwd = join(root, "repo");
    mkdirSync(join(cwd, ".git"), { recursive: true });

    expect(listProjectMcpServers(cwd, noUserConfig()).map((s) => s.name)).toEqual(["outer"]);
  });

  it("reads only cwd when no marker is found or markers are disabled", () => {
    writeProjectConfig(root, '[mcp_servers.outer]\ncommand = "x"\n');
    const cwd = join(root, "repo");
    writeProjectConfig(cwd, '[mcp_servers.inner]\ncommand = "x"\n');
    markRoot(root);

    expect(listProjectMcpServers(cwd, noUserConfig(), []).map((s) => s.name)).toEqual(["inner"]);
    expect(listProjectMcpServers(cwd, noUserConfig(), ["no-such-marker"]).map((s) => s.name)).toEqual(["inner"]);
  });

  it("checks an absolute marker as given for every ancestor, as Rust's Path::join does", () => {
    // The marker exists, so Codex stops at cwd and reads nothing above it.
    // Appending it to each ancestor instead finds it only from `/`.
    const marker = join(root, "marker");
    writeFileSync(marker, "");
    writeProjectConfig(root, '[mcp_servers.outer]\ncommand = "x"\n');
    const cwd = join(root, "repo");
    writeProjectConfig(cwd, '[mcp_servers.inner]\ncommand = "x"\n');
    expect(findProjectRoot(cwd, [marker])).toBe(cwd);
    expect(listProjectMcpServers(cwd, noUserConfig(), [marker]).map((s) => s.name)).toEqual(["inner"]);
    // An absolute marker that does not exist matches nowhere.
    expect(findProjectRoot(cwd, [join(root, "no-such-marker")])).toBeUndefined();
  });

  it("honours custom markers", () => {
    writeProjectConfig(root, '[mcp_servers.outer]\ncommand = "x"\n');
    writeFileSync(join(root, ".hg"), "");
    const cwd = join(root, "repo");
    mkdirSync(cwd);

    expect(listProjectMcpServers(cwd, noUserConfig(), [".hg"]).map((s) => s.name)).toEqual(["outer"]);
  });

  it("keeps names a -c key path could not carry, for buildMcpArgs to quote", () => {
    writeProjectConfig(
      root,
      [
        '[mcp_servers."my.server"]\ncommand = "x"',
        '[mcp_servers."a=b"]\ncommand = "x"',
        "[mcp_servers.'q\"x']\ncommand = \"x\"",
        "[mcp_servers.\"pwn={command='/bin/true',enabled=true}#\"]\ncommand = \"x\"",
      ].join("\n\n"),
    );

    const names = listProjectMcpServers(root, join(root, "home", "config.toml")).map((s) => s.name);
    expect(names.sort()).toEqual(
      ["a=b", "my.server", "pwn={command='/bin/true',enabled=true}#", 'q"x'].sort(),
    );
  });

  it("ignores a nearer partial entry's required flag, which may come from a layer Codex ignores", () => {
    // Trusted root, explicitly untrusted subdirectory: Codex drops the sub
    // layer, so its required = true must not keep the root's server running.
    markRoot(root);
    writeProjectConfig(root, '[mcp_servers.shared]\ncommand = "far"\n');
    const cwd = join(root, "sub");
    writeProjectConfig(cwd, "[mcp_servers.shared]\nrequired = true\n");

    expect(listProjectMcpServers(cwd, join(root, "home", "config.toml"))).toEqual([
      { name: "shared", required: false, projectTransport: { key: "command", value: "far" } },
    ]);
  });

  it("skips entries Codex would reject", () => {
    markRoot(root);
    writeProjectConfig(
      root,
      '[mcp_servers.no_transport]\nenabled = true\n\n[mcp_servers.ok]\ncommand = "x"\n',
    );

    const names = listProjectMcpServers(root, join(root, "home", "config.toml")).map((s) => s.name);
    expect(names).toEqual(["ok"]);
  });

  it("fails closed on a project file it cannot parse, naming it and the inherit escape", () => {
    markRoot(root);
    writeProjectConfig(root, "[mcp_servers.broken\n");
    const file = join(root, ".codex", "config.toml");

    expect(() => listProjectMcpServers(join(root), join(root, "home", "config.toml"))).toThrow(
      new RegExp(`cannot enumerate MCP servers in ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*CODEX_MCP_SERVERS=inherit`),
    );
  });

  it("fails closed on a valid project file past the size cap", () => {
    markRoot(root);
    writeProjectConfig(
      root,
      '[mcp_servers.padded]\ncommand = "x"\n' + "#".repeat(MAX_PROJECT_CONFIG_BYTES),
    );
    expect(() => listProjectMcpServers(root, join(root, "home", "config.toml"))).toThrow(
      /larger than 1048576 bytes/,
    );
  });

  it("reads a project file that starts with a UTF-8 byte order mark, as Codex does", () => {
    markRoot(root);
    writeProjectConfig(root, '\uFEFF[mcp_servers.bomfake]\ncommand = "x"\n');
    expect(listProjectMcpServers(root, join(root, "home", "config.toml")).map((s) => s.name)).toEqual(["bomfake"]);
  });

  it("reads integers past 2^53, which Codex accepts", () => {
    markRoot(root);
    writeProjectConfig(
      root,
      '[mcp_servers.big]\ncommand = "x"\nstartup_timeout_ms = 9007199254740992\n',
    );
    expect(listProjectMcpServers(root, join(root, "home", "config.toml")).map((s) => s.name)).toEqual(["big"]);
  });

  it("treats an absent file, or a .codex that is not a directory, as nothing to read", () => {
    markRoot(root);
    writeFileSync(join(root, ".codex"), "not a directory");
    expect(listProjectMcpServers(root, join(root, "home", "config.toml"))).toEqual([]);
  });
});

describe("effectiveProjectRootMarkers", () => {
  let dir: string;
  let paths: { system: string; managed: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-config-system-"));
    paths = { system: join(dir, "config.toml"), managed: join(dir, "managed_config.toml") };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the system config's markers when the user config sets none", () => {
    writeFileSync(paths.system, 'project_root_markers = [".hg"]\n');
    expect(effectiveProjectRootMarkers({}, paths)).toEqual([".hg"]);
    expect(effectiveProjectRootMarkers(null, paths)).toEqual([".hg"]);
  });

  it("lets the user config override the system config, and managed config override both", () => {
    writeFileSync(paths.system, 'project_root_markers = [".hg"]\n');
    const user = { project_root_markers: [".jj"] };
    expect(effectiveProjectRootMarkers(user, paths)).toEqual([".jj"]);
    writeFileSync(paths.managed, "project_root_markers = []\n");
    expect(effectiveProjectRootMarkers(user, paths)).toEqual([]);
  });

  it("defaults to .git when no layer sets markers or none exists", () => {
    expect(effectiveProjectRootMarkers({}, paths)).toEqual([".git"]);
    expect(effectiveProjectRootMarkers({}, null)).toEqual([".git"]);
  });

  it("fails closed on a system config that exists but cannot be read", () => {
    writeFileSync(paths.system, "project_root_markers = [\n");
    expect(() => effectiveProjectRootMarkers({}, paths)).toThrow(
      new RegExp(`cannot enumerate MCP servers in ${paths.system.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*CODEX_MCP_SERVERS=inherit`),
    );
  });

  it("finds the ancestor root a system marker defines, which .git alone would miss", () => {
    writeFileSync(paths.system, 'project_root_markers = [".hg"]\n');
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(join(repo, ".hg"), "");
    writeFileSync(join(repo, ".codex", "config.toml"), '[mcp_servers.ancestor]\ncommand = "x"\n');
    const cwd = join(repo, "sub");
    mkdirSync(cwd);

    const home = join(dir, "home", "config.toml");
    expect(listProjectMcpServers(cwd, home, effectiveProjectRootMarkers({}, paths)).map((s) => s.name))
      .toEqual(["ancestor"]);
    expect(listProjectMcpServers(cwd, home, effectiveProjectRootMarkers({}, null))).toEqual([]);
  });
});

describe("system and managed config servers", () => {
  let dir: string;
  let paths: { system: string; managed: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-config-sysservers-"));
    paths = { system: join(dir, "config.toml"), managed: join(dir, "managed_config.toml") };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists them like user servers, required from the last layer that sets it", () => {
    writeFileSync(paths.system, '[mcp_servers.sys]\nurl = "http://h"\nrequired = true\n\n[mcp_servers.both]\ncommand = "x"\nrequired = true\n');
    writeFileSync(paths.managed, '[mcp_servers.both]\nrequired = false\n\n[mcp_servers.mgd]\ncommand = "m"\n');
    const user = { mcp_servers: { mine: { command: "u" } } };

    expect(listNonProjectMcpServers(readNonProjectLayers(user, paths))).toEqual([
      { name: "both", required: false },
      { name: "mgd", required: false },
      { name: "mine", required: false },
      { name: "sys", required: true },
    ]);
  });

  it("disables a system server by name, never re-stating an ignored project layer's transport", () => {
    // A system HTTP server and an ignored project layer declaring the same
    // name with `command`: re-stating the command made Codex refuse to
    // start ("url is not supported for stdio").
    writeFileSync(paths.system, '[mcp_servers.shared]\nurl = "http://127.0.0.1:9/mcp"\n');
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/master\n");
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"), '[mcp_servers.shared]\ncommand = "/bin/false"\n');

    // The same composition `getMcpServerOverride` uses, with injected paths.
    const layers = readNonProjectLayers({}, paths);
    const own = listNonProjectMcpServers(layers);
    const project = listProjectMcpServers(
      repo, join(dir, "home", "config.toml"), markersFromLayers(layers), new Set(own.map((s) => s.name)),
    );
    expect(buildMcpArgs(mergeProjectServers(own, project))).toEqual([
      "-c", "mcp_servers={shared={enabled=false}}",
    ]);
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/rest as Codex's AbsolutePathBuf::join does, and nothing else", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/a/b", "/h")).toBe("/h/a/b");
    expect(expandHome("~//a", "/h")).toBe("/h/a");
    expect(expandHome("~/", "/h")).toBe("/h");
    expect(expandHome("~user/a", "/h")).toBe("~user/a");
    expect(expandHome("a/~", "/h")).toBe("a/~");
    expect(expandHome(".git", "/h")).toBe(".git");
  });
});

describe("findProjectRoot with home-relative markers", () => {
  let root: string;
  const origHome = process.env["HOME"];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "codex-config-home-")));
    mkdirSync(join(root, "home"));
    process.env["HOME"] = join(root, "home");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (origHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHome;
  });

  it("checks ~ against the home directory, not a literal ~ directory in the tree", () => {
    const proj = join(root, "proj");
    mkdirSync(join(proj, "~"), { recursive: true });
    mkdirSync(join(proj, ".codex"));
    writeFileSync(join(proj, ".codex", "config.toml"), '[mcp_servers.anc]\ncommand = "x"\n');
    const cwd = join(proj, "sub");
    mkdirSync(cwd);

    // Home exists, so the first ancestor, cwd itself, is the root.
    expect(findProjectRoot(cwd, ["~"])).toBe(cwd);
    expect(listProjectMcpServers(cwd, join(root, "home", "config.toml"), ["~"])).toEqual([]);
  });

  it("finds no root for an absent home-relative marker, even with a literal match in the tree", () => {
    const proj = join(root, "proj");
    mkdirSync(join(proj, "~", "mark"), { recursive: true });
    const cwd = join(proj, "sub");
    mkdirSync(cwd);
    expect(findProjectRoot(cwd, ["~/mark"])).toBeUndefined();
    writeFileSync(join(root, "home", "mark"), "");
    expect(findProjectRoot(cwd, ["~/mark"])).toBe(cwd);
  });
});

describe("projectRootMarkers", () => {
  it("defaults to .git, and takes the user config's array of strings, empty included", () => {
    expect(projectRootMarkers(null)).toEqual([".git"]);
    expect(projectRootMarkers({})).toEqual([".git"]);
    expect(projectRootMarkers({ project_root_markers: [".hg", ".git"] })).toEqual([".hg", ".git"]);
    expect(projectRootMarkers({ project_root_markers: [] })).toEqual([]);
    expect(projectRootMarkers({ project_root_markers: ".hg" })).toEqual([".git"]);
  });
});

describe("mergeProjectServers", () => {
  it("keeps the user entry for a shared name, required flag included, and adds project-only names", () => {
    const user: ConfiguredServer[] = [{ name: "shared", required: false }];
    const project: ConfiguredServer[] = [
      { name: "shared", required: true, projectTransport: { key: "command", value: "p" } },
      { name: "solo", required: false, projectTransport: { key: "url", value: "u" } },
    ];
    // The project file may be one Codex never loaded (untrusted), so it
    // cannot mark a user server required and keep it running.
    expect(mergeProjectServers(user, project)).toEqual([
      { name: "shared", required: false },
      { name: "solo", required: false, projectTransport: { key: "url", value: "u" } },
    ]);
  });
});

describe("buildMcpArgs with project-only servers", () => {
  const project: ConfiguredServer[] = [
    { name: "proj", required: false, projectTransport: { key: "command", value: "/opt/my server" } },
    { name: "web", required: false, projectTransport: { key: "url", value: "http://h/mcp" } },
  ];

  it("re-states the declared transport alongside enabled=false", () => {
    expect(buildMcpArgs(project)).toEqual([
      "-c", 'mcp_servers={proj={enabled=false, command="/opt/my server"}, web={enabled=false, url="http://h/mcp"}}',
    ]);
  });

  it("emits nothing for an enabled project-only server, leaving it to Codex's trust gate", () => {
    expect(buildMcpArgs(project, new Set(["proj"]))).toEqual([
      "-c", 'mcp_servers={web={enabled=false, url="http://h/mcp"}}',
    ]);
  });
});

describe("buildMcpArgs with names a -c key path cannot carry", () => {
  it("encodes a hostile transport value so it parses back to itself", () => {
    const command = 'a}b"c=d\\e,f\ng';
    const args = buildMcpArgs([
      { name: "p", required: false, projectTransport: { key: "command", value: command } },
    ]);

    expect(args).toEqual(["-c", 'mcp_servers={p={enabled=false, command="a}b\\"c=d\\\\e,f\\ng"}}']);
    const [key, ...rest] = args[1]!.split("=");
    expect(key).toBe("mcp_servers");
    // Codex parses the value side as TOML; smol-toml stands in for it here.
    const parsed = parseToml(`v = ${rest.join("=")}`) as { v: { p: { enabled: boolean; command: string } } };
    expect(parsed.v.p).toEqual({ enabled: false, command });
  });

  it("keeps the key path fixed at mcp_servers and quotes names inside the value", () => {
    const pwn = "pwn={command='/bin/true',enabled=true}#";
    const args = buildMcpArgs([
      { name: "a.b", required: false },
      { name: pwn, required: false, projectTransport: { key: "command", value: "x" } },
    ]);
    expect(args).toEqual([
      "-c",
      `mcp_servers={"a.b"={enabled=false}, "${pwn}"={enabled=false, command="x"}}`,
    ]);
    // Codex splits the argument on its first "=": that must be the one
    // after the fixed key.
    expect(args[1]!.split("=")[0]).toBe("mcp_servers");
  });

  it("refuses, with the inherit escape, an override past Linux's one-argument limit", () => {
    const many: ConfiguredServer[] = Array.from({ length: 4000 }, (_, i) => ({
      name: `server-${String(i).padStart(5, "0")}`,
      required: false,
      projectTransport: { key: "command", value: "/opt/some/long/path/to/an/mcp/server" },
    }));
    expect(() => buildMcpArgs(many)).toThrow(
      new RegExp(`over the ${MAX_OVERRIDE_ARG_BYTES}-byte limit.*CODEX_MCP_SERVERS=inherit`),
    );
  });

  it("emits nothing when no server needs an entry", () => {
    expect(buildMcpArgs([{ name: "req", required: true }])).toEqual([]);
  });
});

describe("readProjectConfigText", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-config-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a regular file, and a symlink to one", () => {
    writeFileSync(join(dir, "real.toml"), "a = 1\n");
    symlinkSync(join(dir, "real.toml"), join(dir, "link.toml"));
    expect(readProjectConfigText(join(dir, "real.toml"))).toBe("a = 1\n");
    expect(readProjectConfigText(join(dir, "link.toml"))).toBe("a = 1\n");
  });

  it(`refuses a file over ${MAX_PROJECT_CONFIG_BYTES} bytes`, () => {
    writeFileSync(join(dir, "big.toml"), "#".repeat(MAX_PROJECT_CONFIG_BYTES + 1));
    writeFileSync(join(dir, "edge.toml"), "#".repeat(MAX_PROJECT_CONFIG_BYTES));
    expect(() => readProjectConfigText(join(dir, "big.toml"))).toThrow(/larger than/);
    expect(readProjectConfigText(join(dir, "missing.toml"))).toBeNull();
    expect(readProjectConfigText(join(dir, "edge.toml"))).toHaveLength(MAX_PROJECT_CONFIG_BYTES);
  });

  // A blocking read would freeze this process and any in-process timeout
  // with it, so the special files are read in a child under a hard deadline.
  // SIGKILL, because vite-node's SIGTERM handler cannot run while it is blocked.
  it.skipIf(process.platform === "win32")(
    "refuses a FIFO and a symlink to /dev/zero without blocking",
    () => {
      const fifo = join(dir, "fifo.toml");
      execFileSync("mkfifo", [fifo]);
      const zero = join(dir, "zero.toml");
      symlinkSync("/dev/zero", zero);
      const script = join(dir, "read.mts");
      writeFileSync(
        script,
        `import { readProjectConfigText } from ${JSON.stringify(join(process.cwd(), "src", "utils", "codex-config.ts"))};\n` +
        `const outcome = (p) => { try { return readProjectConfigText(p); } catch (e) { return String(e.message); } };\n` +
        `console.log(JSON.stringify(process.argv.slice(2).map(outcome)));\n`,
      );

      const run = spawnSync(join(process.cwd(), "node_modules", ".bin", "vite-node"), [script, fifo, zero], {
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
      });

      expect(run.signal).toBeNull();
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim().split("\n").pop()!)).toEqual([
        expect.stringContaining("not a regular file"),
        expect.stringContaining("not a regular file"),
      ]);
    },
    40_000,
  );
});

describe("tomlString", () => {
  it("escapes quotes, backslashes and control characters", () => {
    expect(tomlString('C:\\bin\\"x"\n\u0001')).toBe('"C:\\\\bin\\\\\\"x\\"\\n\\u0001"');
  });

  it("leaves plain paths and URLs alone", () => {
    expect(tomlString("http://h:1/mcp?a=b")).toBe('"http://h:1/mcp?a=b"');
  });
});
