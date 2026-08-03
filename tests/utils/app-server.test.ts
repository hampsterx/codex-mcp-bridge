import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppServerSession } from "../../src/utils/app-server.js";
import {
  getActiveCount,
  getQueueDepth,
  resetConcurrency,
} from "../../src/utils/spawn.js";
import { join } from "node:path";

/** Consumes stdin forever and never answers, so requests must time out. */
const SILENT = join(process.cwd(), "tests", "fixtures", "fake-app-server-silent.sh");
/** Exits immediately, so writes hit a dead child. */
const DIES = join(process.cwd(), "tests", "fixtures", "fake-app-server-dies.sh");

/**
 * These cover the lifecycle contract, not the protocol: a live app-server
 * session costs 7-10s and boots the user's real MCP servers, so protocol
 * behaviour is pinned by the recorded fixtures in mcp-status.test.ts instead.
 */
describe("AppServerSession lifecycle", () => {
  const origPath = process.env["CODEX_CLI_PATH"];

  beforeEach(() => {
    resetConcurrency(2);
  });

  afterEach(() => {
    if (origPath === undefined) delete process.env["CODEX_CLI_PATH"];
    else process.env["CODEX_CLI_PATH"] = origPath;
    resetConcurrency();
  });

  it("holds exactly one concurrency slot while open", async () => {
    process.env["CODEX_CLI_PATH"] = SILENT;
    const session = new AppServerSession();
    await session.open();
    expect(getActiveCount()).toBe(1);
    session.close();
    expect(getActiveCount()).toBe(0);
  });

  it("releases the slot exactly once even if close is called repeatedly", async () => {
    process.env["CODEX_CLI_PATH"] = SILENT;
    const session = new AppServerSession();
    await session.open();
    session.close();
    session.close();
    session.close();
    // A double release would drive the count negative or free a slot the
    // session never held, letting concurrency drift above the configured max.
    expect(getActiveCount()).toBe(0);
    expect(getQueueDepth()).toBe(0);
  });

  it("releases the slot when the binary does not exist", async () => {
    process.env["CODEX_CLI_PATH"] = "/nonexistent/codex-binary";
    const session = new AppServerSession();
    await session.open(); // spawn error surfaces asynchronously
    await expect(session.request("initialize", {})).rejects.toThrow(/not found|failed/i);
    session.close();
    expect(getActiveCount()).toBe(0);
  });

  it("rejects a request that outlives its timeout, and drops the pending entry", async () => {
    process.env["CODEX_CLI_PATH"] = SILENT;
    const session = new AppServerSession({ requestTimeout: 150 });
    await session.open();
    // The fake server swallows stdin and never writes a response envelope,
    // so nothing resolves and the timeout must fire.
    await expect(session.request("initialize", {})).rejects.toThrow(/timed out/);
    session.close();
    expect(getActiveCount()).toBe(0);
  });

  it("refuses to reuse a closed session", async () => {
    process.env["CODEX_CLI_PATH"] = SILENT;
    const session = new AppServerSession();
    await session.open();
    session.close();
    await expect(session.request("initialize", {})).rejects.toThrow(/closed/);
  });

  it("parses notifications split across chunk boundaries", async () => {
    process.env["CODEX_CLI_PATH"] = SILENT;
    const session = new AppServerSession();
    await session.open();

    const seen: string[] = [];
    session.onNotification((n) => seen.push(n.method));

    // Drive the parser directly: stdout arrives in arbitrary chunks, and a
    // JSON object split mid-line must not be dropped or mis-parsed.
    const ingest = (session as unknown as { ingest: (s: string) => void }).ingest.bind(session);
    ingest('{"method":"mcpServer/star');
    ingest('tupStatus/updated","params":{"name":"a","status":"ready"}}\n');
    ingest('{"method":"thread/started","params":{}}\n{"method":"x","params":{}}\n');

    expect(seen).toEqual([
      "mcpServer/startupStatus/updated",
      "thread/started",
      "x",
    ]);
    session.close();
  });

  it("ignores non-JSON banner lines without dropping later messages", async () => {
    process.env["CODEX_CLI_PATH"] = SILENT;
    const session = new AppServerSession();
    await session.open();

    const seen: string[] = [];
    session.onNotification((n) => seen.push(n.method));
    const ingest = (session as unknown as { ingest: (s: string) => void }).ingest.bind(session);
    ingest("some banner text\n");
    ingest('{"method":"thread/started","params":{}}\n');

    expect(seen).toEqual(["thread/started"]);
    session.close();
  });
});

describe("AppServerSession against a child that has already exited", () => {
  const origPath = process.env["CODEX_CLI_PATH"];

  beforeEach(() => resetConcurrency(2));
  afterEach(() => {
    if (origPath === undefined) delete process.env["CODEX_CLI_PATH"];
    else process.env["CODEX_CLI_PATH"] = origPath;
    resetConcurrency();
  });

  it("rejects rather than crashing the process on EPIPE", async () => {
    // Writing to a dead child's stdin emits an 'error' event on the socket.
    // Unhandled, that is an uncaught exception that kills the whole bridge,
    // not just this session.
    process.env["CODEX_CLI_PATH"] = DIES;
    const session = new AppServerSession({ requestTimeout: 500 });
    await session.open();
    await new Promise((r) => setTimeout(r, 150)); // let it die

    await expect(session.request("initialize", {})).rejects.toThrow();
    expect(() => session.notify("initialized", {})).not.toThrow();

    session.close();
    expect(getActiveCount()).toBe(0);
  });
});
