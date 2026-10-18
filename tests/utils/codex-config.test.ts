import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      { name: "inner", required: true, projectTransport: { key: "command", value: "./serve.sh" } },
      { name: "outer", required: false, projectTransport: { key: "url", value: "http://127.0.0.1:1/mcp" } },
    ]);
  });

  it("takes the transport nearest cwd, and required from the farther file when the nearer omits it", () => {
    markRoot(root);
    writeProjectConfig(root, '[mcp_servers.dup]\nurl = "http://far"\nrequired = true\n');
    const cwd = join(root, "repo");
    writeProjectConfig(cwd, '[mcp_servers.dup]\ncommand = "near"\n');

    expect(listProjectMcpServers(cwd, join(root, "home", "config.toml"))).toEqual([
      { name: "dup", required: true, projectTransport: { key: "command", value: "near" } },
    ]);
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

  it("merges a nearer partial entry into a farther declaration, as Codex does", () => {
    markRoot(root);
    writeProjectConfig(root, '[mcp_servers.foo]\ncommand = "far"\n\n[mcp_servers.bar]\ncommand = "b"\nrequired = true\n');
    const cwd = join(root, "repo");
    writeProjectConfig(cwd, "[mcp_servers.foo]\nrequired = true\n\n[mcp_servers.bar]\nrequired = false\n");

    expect(listProjectMcpServers(cwd, join(root, "home", "config.toml"))).toEqual([
      { name: "bar", required: false, projectTransport: { key: "command", value: "b" } },
      { name: "foo", required: true, projectTransport: { key: "command", value: "far" } },
    ]);
  });

  it("skips unparseable files and entries Codex would reject", () => {
    markRoot(root);
    writeProjectConfig(root, "[mcp_servers.broken\n");
    const cwd = join(root, "repo");
    writeProjectConfig(
      cwd,
      '[mcp_servers.no_transport]\nenabled = true\n\n[mcp_servers.ok]\ncommand = "x"\n',
    );

    const names = listProjectMcpServers(cwd, join(root, "home", "config.toml")).map((s) => s.name);
    expect(names).toEqual(["ok"]);
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
    expect(readProjectConfigText(join(dir, "big.toml"))).toBeNull();
    expect(readProjectConfigText(join(dir, "edge.toml"))).toHaveLength(MAX_PROJECT_CONFIG_BYTES);
  });

  // A blocking read would freeze this process and any in-process timeout
  // with it, so the special files are read in a child under a hard deadline.
  // SIGKILL, because vite-node's SIGTERM handler cannot run while it is blocked.
  it.skipIf(process.platform === "win32")(
    "returns null for a FIFO and for a symlink to /dev/zero without blocking",
    () => {
      const fifo = join(dir, "fifo.toml");
      execFileSync("mkfifo", [fifo]);
      const zero = join(dir, "zero.toml");
      symlinkSync("/dev/zero", zero);
      const script = join(dir, "read.mts");
      writeFileSync(
        script,
        `import { readProjectConfigText } from ${JSON.stringify(join(process.cwd(), "src", "utils", "codex-config.ts"))};\n` +
        `console.log(JSON.stringify(process.argv.slice(2).map((p) => readProjectConfigText(p))));\n`,
      );

      const run = spawnSync(join(process.cwd(), "node_modules", ".bin", "vite-node"), [script, fifo, zero], {
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
      });

      expect(run.signal).toBeNull();
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim().split("\n").pop()!)).toEqual([null, null]);
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
