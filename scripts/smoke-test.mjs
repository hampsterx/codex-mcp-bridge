#!/usr/bin/env node

/**
 * Smoke test for codex-mcp-bridge tool functions.
 *
 * Bypasses the running MCP server and imports compiled tool functions
 * directly, so you can test changes without restarting your MCP client.
 *
 * Usage:
 *   npm run build && node scripts/smoke-test.mjs [tool] [workingDirectory]
 *
 * Examples:
 *   node scripts/smoke-test.mjs                     # codex tool, cwd
 *   node scripts/smoke-test.mjs codex /tmp           # codex tool, /tmp
 *   node scripts/smoke-test.mjs search               # web search
 *   node scripts/smoke-test.mjs query                # lightweight query
 *   node scripts/smoke-test.mjs ping                 # health check
 */

import { homedir } from "os";

const tool = process.argv[2] || "codex";
const rawDir = process.argv[3] || process.cwd();
const workingDirectory =
  rawDir === "~"
    ? homedir()
    : rawDir.startsWith("~/")
      ? rawDir.replace(/^~(?=\/)/, homedir())
      : rawDir;

console.log(`\n--- smoke-test: ${tool} ---`);
console.log(`workingDirectory: ${workingDirectory}\n`);

try {
  if (tool === "codex") {
    const { executeCodex } = await import("../dist/tools/codex.js");
    const result = await executeCodex({
      prompt: 'Reply with exactly: "pong"',
      workingDirectory,
      timeout: 60_000,
      maxResponseLength: 10,
    });
    console.log("response:", result.response);
    console.log("sessionId:", result.sessionId);
    console.log("timedOut:", result.timedOut);
  } else if (tool === "search") {
    const { executeSearch } = await import("../dist/tools/search.js");
    const result = await executeSearch({
      query: "What is MCP (Model Context Protocol)?",
      workingDirectory,
      timeout: 120_000,
      maxResponseLength: 50,
    });
    console.log("response:", result.response.slice(0, 200) + (result.response.length > 200 ? "..." : ""));
    console.log("timedOut:", result.timedOut);
  } else if (tool === "query") {
    const { executeQuery } = await import("../dist/tools/query.js");
    const result = await executeQuery({
      prompt: "What are the pros and cons of this approach?",
      context: "Using a temp directory as cwd to isolate subprocess context.",
      timeout: 60_000,
      maxResponseLength: 50,
    });
    console.log("response:", result.response.slice(0, 200) + (result.response.length > 200 ? "..." : ""));
    console.log("timedOut:", result.timedOut);
  } else if (tool === "ping") {
    const { executePing } = await import("../dist/tools/ping.js");
    const result = await executePing();
    console.log("cliFound:", result.cliFound);
    console.log("version:", result.version);
    console.log("authStatus:", result.authStatus);
    console.log("defaultModel:", result.defaultModel);
    console.log("fallbackModel:", result.fallbackModel);
    console.log("serverVersion:", result.serverVersion);
  } else if (tool === "structured") {
    const { executeStructured } = await import("../dist/tools/structured.js");
    const result = await executeStructured({
      prompt: "What is 2 + 2?",
      schema: JSON.stringify({
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      }),
      workingDirectory,
      timeout: 60_000,
    });
    console.log("response:", result.response.slice(0, 200));
    console.log("valid:", result.valid);
    console.log("timedOut:", result.timedOut);
  } else if (tool === "listSessions") {
    const { sessionStore } = await import("../dist/utils/session.js");
    const sessions = sessionStore.list();
    console.log(`Active sessions: ${sessions.length}`);
    for (const { sessionId, entry } of sessions) {
      console.log(`  ${sessionId}: turns=${entry.turnCount}, model=${entry.model ?? "unknown"}, created=${new Date(entry.createdAt).toISOString()}`);
    }
  } else {
    console.error(`Unknown tool: ${tool}. Use: codex, search, query, ping, structured, listSessions`);
    process.exit(1);
  }

  console.log("\n--- PASS ---");
} catch (e) {
  console.error("\n--- FAIL ---");
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
