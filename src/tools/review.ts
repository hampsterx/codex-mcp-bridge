import { spawnCodex } from "../utils/spawn.js";
import { parseCodexOutput } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { loadPrompt, buildLengthLimit } from "../utils/prompts.js";
import { getGitRoot, getUncommittedDiff, getBranchDiff, getDiffStat, validateBaseRef, type DiffStat, type DiffSpec } from "../utils/git.js";
import { verifyDirectory } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";
import {
  getMcpServerOverride,
  willEnableServer,
  scanTimeoutMs,
  focusedBaseMs,
  focusedPerFileMs,
  focusedCapMs,
  focusedFallbackMs,
  deepBaseMs,
  deepPerFileMs,
  deepFallbackMs,
} from "../utils/env.js";

/** Review depth tier. Callers pick based on diff size + how much context they want. */
export type ReviewDepth = "scan" | "focused" | "deep";

export interface ReviewInput {
  uncommitted?: boolean;
  base?: string;
  focus?: string;
  /** Review depth. Takes precedence over `quick` when both are set. Default: "deep". */
  depth?: ReviewDepth;
  /** @deprecated Use `depth` instead. `quick: true` maps to `depth: "scan"`, `quick: false` to `depth: "deep"`. */
  quick?: boolean;
  model?: string;
  workingDirectory?: string;
  timeout?: number;
  maxResponseLength?: number;
  /**
   * MCP servers to enable for this review, using the CODEX_MCP_SERVERS grammar
   * (comma-separated list, "inherit", raw TOML, or empty string to disable all
   * non-required servers). Servers marked `required = true` in `config.toml`
   * (codex PR #10902) stay enabled regardless of the value — the bridge
   * refuses to disable them and will warn loudly if the caller's list would
   * have dropped one. When unset, the per-depth default applies:
   * deep → "serena", focused → "", scan → "". Setting this explicitly
   * overrides both the tool default and the CODEX_MCP_SERVERS env var.
   */
  mcpServers?: string;
}

export interface ReviewResult {
  response: string;
  diffSource: "uncommitted" | "branch";
  base?: string;
  /**
   * Actual depth the review ran at. Breaking change in this release: was
   * `"agentic" | "quick"` in v0.4.x.
   */
  mode: ReviewDepth;
  model?: string;
  fallbackUsed?: boolean;
  timedOut: boolean;
  /** Diff size stats (files/insertions/deletions) when available. */
  diffStat?: DiffStat;
  /** Timeout actually applied to the spawn (ms), including any dynamic scaling. */
  appliedTimeout: number;
  /** True when appliedTimeout came from diff-size auto-scaling (focused/deep only, no caller override). */
  timeoutScaled: boolean;
}

/**
 * Total insertions+deletions above which focused mode emits a warning
 * suggesting depth:"deep". Pre-inlining the diff plus changed-file reads
 * puts pressure on the context window at scale.
 */
const FOCUSED_LARGE_DIFF_THRESHOLD = 1000;

/**
 * Map diff size to a timeout budget for the requested depth.
 *
 * - `scan`: constant (see `scanTimeoutMs`), independent of diff size.
 * - `focused`: `base + per-file * files`, capped. Cheaper than deep because
 *   containment is tighter, but still needs more room for larger diffs.
 * - `deep`: `base + per-file * files`, capped at `HARD_TIMEOUT_CAP`. Covers
 *   the CLI cold start plus generous per-file budget for the exploration
 *   the agent does (reads, greps, follows imports, checks tests).
 */
export function scaleTimeoutForDepth(depth: ReviewDepth, stat: DiffStat): number {
  switch (depth) {
    case "scan":
      return scanTimeoutMs();
    case "focused":
      return Math.min(focusedBaseMs() + focusedPerFileMs() * stat.files, focusedCapMs());
    case "deep":
      return Math.min(deepBaseMs() + deepPerFileMs() * stat.files, HARD_TIMEOUT_CAP);
    default: {
      const _exhaustive: never = depth;
      throw new Error(`Unknown review depth: ${_exhaustive as string}`);
    }
  }
}

/** Fallback timeout when the diff stat is unavailable (no file-count term). */
export function defaultTimeoutForDepth(depth: ReviewDepth): number {
  switch (depth) {
    case "scan":
      return scanTimeoutMs();
    case "focused":
      return focusedFallbackMs();
    case "deep":
      return deepFallbackMs();
    default: {
      const _exhaustive: never = depth;
      throw new Error(`Unknown review depth: ${_exhaustive as string}`);
    }
  }
}

/**
 * Replace the standard timeout message with one that includes diff size and
 * an actionable hint. Post-processes rather than threading stat into parse.ts
 * so parse.ts stays ignorant of review-specific context.
 */
function annotatePartialWithStat(
  timeoutSeconds: number,
  diffStat: DiffStat | undefined,
  depth: ReviewDepth,
): string {
  const prefix = `Review timed out after ${timeoutSeconds}s.`;
  // Scan has no shallower option, so don't suggest a depth downgrade.
  const hint = depth === "scan"
    ? "Try reviewing a smaller scope."
    : `Consider depth: "scan" or narrow the base.`;
  if (!diffStat) {
    return `${prefix} ${hint}`;
  }
  return `${prefix} Diff: ${diffStat.files} files (+${diffStat.insertions} / -${diffStat.deletions}). ${hint}`;
}

/**
 * Deep (agentic) review prompt. Codex CLI runs in --full-auto with shell access.
 * It will run git diff, read files, follow imports.
 *
 * When `useSerenaPrompt` is true, loads the serena-aware variant that tells
 * Codex to prefer Serena MCP tools (get_symbols_overview, find_symbol,
 * find_referencing_symbols) over cat/grep. Callers should set this only when
 * the serena MCP server is actually enabled for the subprocess — otherwise
 * the LLM will try to call tools that don't exist.
 */
export function buildAgenticPrompt(
  diffSpec: string,
  focus?: string,
  maxResponseLength?: number,
  useSerenaPrompt = false,
): string {
  const file = useSerenaPrompt ? "review-agentic-with-serena.md" : "review-agentic.md";
  return loadPrompt(file, {
    DIFF_SPEC: diffSpec,
    FOCUS_SECTION: focus ? `## Focus Area\n\nPay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
}

/**
 * Scan review prompt. Pre-computed diff, no repo exploration.
 */
export function buildQuickPrompt(diff: string, focus?: string, maxResponseLength?: number): string {
  return loadPrompt("review-quick.md", {
    DIFF: diff,
    FOCUS_SECTION: focus ? `Pay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
}

/**
 * Focused review prompt. Pre-computed diff + instructions to read changed
 * files only. Spawned with `--sandbox read-only --skip-git-repo-check
 * --ephemeral` (same containment stack as the `query` tool). Codex can still
 * shell out — containment past the read-only sandbox is prompt-driven.
 */
export function buildFocusedPrompt(diff: string, focus?: string, maxResponseLength?: number): string {
  return loadPrompt("review-focused.md", {
    DIFF: diff,
    FOCUS_SECTION: focus ? `Pay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
}

/**
 * Resolve the requested depth from input. `depth` wins over `quick` when both
 * are set (logs a one-line deprecation warning to stderr). Legacy mapping:
 * `quick: true` → `"scan"`, `quick: false` or unset → `"deep"`.
 */
export function resolveDepth(input: { depth?: ReviewDepth; quick?: boolean }): ReviewDepth {
  if (input.depth) {
    if (input.quick !== undefined) {
      console.warn(
        `codex-mcp-bridge: 'quick' is deprecated and ignored when 'depth' is set (depth="${input.depth}")`,
      );
    }
    return input.depth;
  }
  if (input.quick === true) return "scan";
  return "deep";
}

/**
 * Execute a code review at the requested depth.
 *
 * Depths:
 * - `scan`: diff-only, single-pass, no repo exploration. Fastest, shallowest.
 *   Matches the old `quick: true` behaviour.
 * - `focused`: diff + read changed files only. Sandbox is read-only plus
 *   `--ephemeral` / `--skip-git-repo-check` to reduce ambient context.
 * - `deep` (default): full agentic exploration with `--full-auto`. Codex
 *   runs git itself, follows imports, checks tests, reads project files.
 */
export async function executeReview(input: ReviewInput): Promise<ReviewResult> {
  const { uncommitted = true, base, focus, maxResponseLength } = input;
  const model = resolveModel(input.model);
  const depth = resolveDepth(input);

  const requestedDir = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();
  const cwd = getGitRoot(requestedDir);

  const diffSpec: DiffSpec = base ? { type: "branch", base } : { type: "uncommitted" };
  const diffStat = getDiffStat(cwd, diffSpec);

  // Timeout selection:
  //   - caller-supplied timeout always wins (capped at HARD_TIMEOUT_CAP)
  //   - else scale from diff stat when available
  //   - else fall back to the per-depth default
  // `timeoutScaled` only flips for focused/deep — scan is a constant
  // regardless of diff size so it doesn't count as "scaled".
  let appliedTimeout: number;
  let timeoutScaled = false;
  if (input.timeout !== undefined) {
    appliedTimeout = Math.min(input.timeout, HARD_TIMEOUT_CAP);
  } else if (diffStat) {
    appliedTimeout = scaleTimeoutForDepth(depth, diffStat);
    timeoutScaled = depth !== "scan";
  } else {
    appliedTimeout = defaultTimeoutForDepth(depth);
  }

  // Resolve the effective CODEX_MCP_SERVERS value:
  //   1. Explicit input.mcpServers wins.
  //   2. Otherwise CODEX_MCP_SERVERS env var, if set.
  //   3. Otherwise: deep → "serena" (symbol nav), focused/scan → "" (disable all).
  const envVal = process.env["CODEX_MCP_SERVERS"];
  const callerExplicit = input.mcpServers !== undefined || envVal !== undefined;
  const mcpServers =
    input.mcpServers ??
    (envVal !== undefined ? envVal : depth === "deep" ? "serena" : "");
  const silentMcp = !callerExplicit;

  return runReview(depth, {
    cwd,
    uncommitted,
    base,
    focus,
    model,
    timeout: appliedTimeout,
    maxResponseLength,
    mcpServers,
    silentMcp,
    diffStat,
    timeoutScaled,
  });
}

interface InternalReviewInput {
  cwd: string;
  uncommitted: boolean;
  base?: string;
  focus?: string;
  model?: string;
  timeout: number;
  maxResponseLength?: number;
  mcpServers: string;
  silentMcp: boolean;
  diffStat?: DiffStat;
  timeoutScaled: boolean;
}

interface ReviewMeta {
  appliedTimeout: number;
  timeoutScaled: boolean;
  diffStat?: DiffStat;
}

/**
 * Unified review runner. Handles diff source resolution, empty-diff early
 * exit, model fallback, spawn, timeout annotation, and result shaping.
 * Per-depth config (prompt + spawn args) is selected by the `depth` param.
 */
async function runReview(depth: ReviewDepth, input: InternalReviewInput): Promise<ReviewResult> {
  const { cwd, uncommitted, base, focus, model, timeout, maxResponseLength, mcpServers, silentMcp, diffStat, timeoutScaled } = input;
  const meta: ReviewMeta = { appliedTimeout: timeout, timeoutScaled, diffStat };

  let diffSource: ReviewResult["diffSource"];
  if (base) {
    validateBaseRef(base);
    diffSource = "branch";
  } else if (uncommitted) {
    diffSource = "uncommitted";
  } else {
    throw new Error("Either 'uncommitted' must be true or 'base' must be specified");
  }

  // Compute the diff once. scan/focused inline it in the prompt; deep uses
  // only the diff-spec command and lets Codex run git itself. All three need
  // the content for the empty-diff early exit.
  let diff: string;
  try {
    diff = base ? getBranchDiff(cwd, base) : getUncommittedDiff(cwd);
  } catch (e) {
    if (isNoChangesError(e)) {
      return emptyResult(depth, diffSource, base, meta, (e as Error).message);
    }
    throw e;
  }
  if (!diff.trim()) {
    const msg = base
      ? `No diff found between ${base} and HEAD.`
      : "No uncommitted changes found.";
    return emptyResult(depth, diffSource, base, meta, msg);
  }

  // Per-depth prompt + spawn args.
  let prompt: string;
  let spawnExtra: string[];
  switch (depth) {
    case "deep": {
      const diffSpec = base ? `git diff ${base}...HEAD -U5` : "git diff HEAD -U5";
      const useSerenaPrompt = willEnableServer(mcpServers, "serena");
      prompt = buildAgenticPrompt(diffSpec, focus, maxResponseLength, useSerenaPrompt);
      // --full-auto implies sandbox; don't combine with explicit --sandbox.
      spawnExtra = ["--full-auto", "--skip-git-repo-check"];
      break;
    }
    case "focused": {
      prompt = buildFocusedPrompt(diff, focus, maxResponseLength);
      // Same containment stack as the `query` tool: read-only sandbox plus
      // `--skip-git-repo-check --ephemeral` to reduce ambient repo context.
      // Containment past "no writes" is prompt-driven; Codex can still shell.
      spawnExtra = ["--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"];
      break;
    }
    case "scan": {
      prompt = buildQuickPrompt(diff, focus, maxResponseLength);
      spawnExtra = ["--sandbox", "read-only", "--skip-git-repo-check"];
      break;
    }
    default: {
      const _exhaustive: never = depth;
      throw new Error(`Unknown review depth: ${_exhaustive as string}`);
    }
  }

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = ["exec", ...getMcpServerOverride(mcpServers, { silent: silentMcp })];
      if (m) args.push("--model", m);
      args.push(...spawnExtra);
      return spawnCodex({ args, cwd, stdin: prompt, timeout: t });
    },
    timeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    return {
      response: annotatePartialWithStat(timeout / 1000, diffStat, depth),
      diffSource,
      base,
      mode: depth,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      timedOut: true,
      ...meta,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr, result.stdout);

  const parsed = parseCodexOutput(result.stdout, result.stderr);

  // Attach a large-diff warning to focused reviews. Pre-inlining the diff +
  // reading changed files puts pressure on the context window; deep mode's
  // streamed exploration scales better on large diffs.
  let response = parsed.response;
  if (
    depth === "focused" &&
    diffStat &&
    diffStat.insertions + diffStat.deletions > FOCUSED_LARGE_DIFF_THRESHOLD
  ) {
    const warning = `\n\n---\n**Note:** large diff (+${diffStat.insertions} / -${diffStat.deletions} across ${diffStat.files} files) — focused mode may have missed context-window-pressured findings. Consider re-running with \`depth: "deep"\`.`;
    response += warning;
  }

  return {
    response,
    diffSource,
    base,
    mode: depth,
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    timedOut: false,
    ...meta,
  };
}

function isNoChangesError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes("No uncommitted changes") || e.message.includes("No diff found");
}

function emptyResult(
  depth: ReviewDepth,
  diffSource: ReviewResult["diffSource"],
  base: string | undefined,
  meta: ReviewMeta,
  message: string,
): ReviewResult {
  return {
    response: message,
    diffSource,
    base,
    mode: depth,
    timedOut: false,
    ...meta,
  };
}
