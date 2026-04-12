#!/usr/bin/env node

/**
 * A/B test: How much does MCP boot time cost an agentic review?
 *
 * Runs the same agentic review twice:
 *   Run A: mcpServers=""        (disable every configured server — no-MCP control)
 *   Run B: mcpServers="inherit" (all configured MCP servers, the realistic
 *                                upper bound on boot cost — not a serena-only
 *                                treatment; pass mcpServers="serena" manually
 *                                if you want to isolate just the serena cost)
 *
 * Note: passing `undefined` as the second arg is NOT a no-MCP run, because
 * review.ts defaults agentic mode to `"serena"` when the caller doesn't set
 * an explicit value. The control has to pass `""` to actually disable.
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
  // Ensure the env var can't leak between runs. We pass `mcpServers`
  // explicitly through the tool input so review.ts's agentic default
  // ("serena" when unset) never kicks in.
  delete process.env.CODEX_MCP_SERVERS;

  console.log(`--- ${label} (mcpServers="${mcpServers}") ---`);
  const start = performance.now();

  try {
    const result = await executeReview({
      uncommitted: true,
      quick: false,  // agentic mode
      workingDirectory,
      timeout: 300_000,
      mcpServers,
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

// Run A: No MCP servers (explicit disable-all, bypassing the agentic default)
const runA = await runReview("Run A: No MCP servers", "");

console.log("\n" + "=".repeat(60) + "\n");

// Run B: Inherit all MCP servers (including Serena)
const runB = await runReview("Run B: Inherit MCP servers", "inherit");

console.log("\n" + "=".repeat(60));
console.log("=== Summary ===");
console.log(`Run A (no MCP):      ${runA.elapsed}s, ${runA.result?.response?.length ?? "N/A"} chars`);
console.log(`Run B (inherit MCP): ${runB.elapsed}s, ${runB.result?.response?.length ?? "N/A"} chars`);
console.log(`Time delta: ${runB.error ? "N/A" : (parseFloat(runB.elapsed) - parseFloat(runA.elapsed)).toFixed(1)}s`);
console.log("=".repeat(60));
