#!/usr/bin/env node

/**
 * A/B test: Does Codex use Serena MCP tools during agentic review?
 *
 * Runs the same agentic review twice:
 *   Run A: CODEX_MCP_SERVERS='{}' (no MCP servers — default bridge behavior)
 *   Run B: CODEX_MCP_SERVERS='inherit' (all configured MCP servers)
 *
 * Compares wall time and captures full output for quality comparison.
 *
 * Usage: npm run build && node scripts/serena-test.mjs [workingDirectory]
 */

import { homedir } from "os";
import { performance } from "perf_hooks";

const rawDir = process.argv[2] || process.cwd();
const workingDirectory =
  rawDir === "~"
    ? homedir()
    : rawDir.startsWith("~/")
      ? rawDir.replace(/^~(?=\/)/, homedir())
      : rawDir;

console.log(`\n=== Serena Hypothesis Test ===`);
console.log(`Target repo: ${workingDirectory}`);
console.log(`Date: ${new Date().toISOString()}\n`);

const { executeReview } = await import("../dist/tools/review.js");

async function runReview(label, mcpServers) {
  // Set the env var before each run
  if (mcpServers === undefined) {
    delete process.env.CODEX_MCP_SERVERS;
  } else {
    process.env.CODEX_MCP_SERVERS = mcpServers;
  }

  console.log(`--- ${label} (CODEX_MCP_SERVERS=${mcpServers ?? "<unset>"}) ---`);
  const start = performance.now();

  try {
    const result = await executeReview({
      uncommitted: true,
      quick: false,  // agentic mode
      workingDirectory,
      timeout: 300_000,
    });

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    console.log(`Wall time: ${elapsed}s`);
    console.log(`Mode: ${result.mode}`);
    console.log(`Timed out: ${result.timedOut}`);
    console.log(`Model: ${result.model}`);
    console.log(`Response length: ${result.response.length} chars`);
    console.log(`\n--- Full response ---\n${result.response}\n`);

    return { elapsed, result };
  } catch (e) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    console.log(`FAILED after ${elapsed}s: ${e.message}`);
    return { elapsed, error: e.message };
  }
}

// Run A: No MCP servers (default bridge behavior)
const runA = await runReview("Run A: No MCP servers", undefined);

console.log("\n" + "=".repeat(60) + "\n");

// Run B: Inherit all MCP servers (including Serena)
const runB = await runReview("Run B: Inherit MCP servers", "inherit");

console.log("\n" + "=".repeat(60));
console.log("=== Summary ===");
console.log(`Run A (no MCP):      ${runA.elapsed}s, ${runA.result?.response?.length ?? "N/A"} chars`);
console.log(`Run B (inherit MCP): ${runB.elapsed}s, ${runB.result?.response?.length ?? "N/A"} chars`);
console.log(`Time delta: ${runB.error ? "N/A" : (parseFloat(runB.elapsed) - parseFloat(runA.elapsed)).toFixed(1)}s`);
console.log("=".repeat(60));
