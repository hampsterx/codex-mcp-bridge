import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnCodex } from "../utils/spawn.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";
import { verifyDirectory } from "../utils/security.js";
import { redactSecrets } from "../utils/parse.js";
import {
  parseReviewStream,
  type ReviewParseResult,
  type ReviewMeta,
} from "../utils/review-events.js";
import { escapeArg } from "../utils/windows.js";

export interface ReviewInput {
  mode: "uncommitted" | "base" | "commit";
  base?: string;
  commit?: string;
  title?: string;
  model?: string;
  workingDirectory?: string;
  timeout?: number;
}

export interface ReviewResult {
  response: string;
  model?: string;
  fallbackUsed?: boolean;
  timedOut: boolean;
  mode: ReviewInput["mode"];
  threadId?: string;
  meta: ReviewMeta;
}

interface BuildReviewArgsInput {
  mode: ReviewInput["mode"];
  base?: string;
  commit?: string;
  title?: string;
  model?: string;
  outputFile: string;
}

/** Default timeout for native review operations. */
const REVIEW_TIMEOUT = 180_000;

/**
 * Execute Codex's native diff-aware review command.
 *
 * This is intentionally prompt-free: upstream Codex owns the review prompt.
 * The bridge supplies only diff selector flags and hardened execution flags.
 */
export async function executeReview(input: ReviewInput): Promise<ReviewResult> {
  validateReviewInput(input);
  const cwd = await verifyDirectory(input.workingDirectory!);
  const model = resolveModel(input.model);
  const timeout = Math.min(input.timeout ?? REVIEW_TIMEOUT, HARD_TIMEOUT_CAP);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-review-"));
  const outputFile = path.join(tempDir, "review.txt");

  try {
    const { result, fallbackUsed, fallbackModel } = await withModelFallback(
      model,
      (m, t) => {
        const args = buildReviewArgs({
          mode: input.mode,
          base: input.base,
          commit: input.commit,
          title: input.title,
          model: m,
          outputFile,
        });
        return spawnCodex({ args, cwd, timeout: t });
      },
      timeout,
    );

    const parsed = parseReviewOutput(result.stdout, result.stderr);
    const fileText = await readOutputFile(outputFile);
    const finalText = fileText && fileText.length > 0 ? redactSecrets(fileText) : parsed.finalText;
    const actualModel = fallbackUsed ? fallbackModel : model;

    if (result.timedOut) {
      return buildReviewResult(input.mode, finalText, parsed.meta, actualModel, fallbackUsed, true);
    }

    // A fatal Codex event (turn.failed / top-level error) surfaces as an MCP
    // error rather than returning partial or empty output as a successful
    // review. Codex can exit 0 on a failed turn, so this cannot rely on exitCode.
    if (parsed.meta.fatalError) {
      throw new Error(parsed.meta.fatalError);
    }

    checkErrorPatterns(result.exitCode, result.stderr, finalText ?? undefined);

    if (result.exitCode !== 0) {
      const details = result.stderr.trim()
        ? `: ${redactSecrets(result.stderr.trim())}`
        : "";
      throw new Error(`Codex review exited with code ${result.exitCode}${details}`);
    }

    if (!finalText && hasReviewEvents(parsed.meta)) {
      throw new Error("Codex review produced JSONL events but no final review message");
    }

    if (!finalText && (result.stdout.trim() || result.stderr.trim()) && parsed.meta.parseFailures > 0) {
      throw new Error("Codex review output could not be parsed");
    }

    return buildReviewResult(input.mode, finalText, parsed.meta, actualModel, fallbackUsed, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Build Codex native review args.
 */
export function buildReviewArgs(input: BuildReviewArgsInput): string[] {
  const args = [
    "exec",
    "review",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--full-auto",
    "-o",
    escapeArg(input.outputFile),
  ];

  // `--flag=value` rather than `--flag value`: every one of these values is an
  // unconstrained caller string. In the space form Codex refuses a
  // dash-prefixed value outright ("a value is required for '--title <TITLE>'"),
  // so a branch named `--foo` fails the whole review instead of being reviewed.
  // The `=` form binds the value to its flag whatever it starts with.
  if (input.mode === "uncommitted") {
    args.push("--uncommitted");
  } else if (input.mode === "base") {
    args.push(`--base=${input.base!}`);
  } else {
    args.push(`--commit=${input.commit!}`);
  }

  if (input.title) args.push(`--title=${input.title}`);
  if (input.model) args.push(`--model=${input.model}`);

  return args;
}

function validateReviewInput(input: ReviewInput): void {
  if (!input.workingDirectory) {
    throw new Error("workingDirectory is required for review because Codex review needs a real git repository");
  }
  if (!["uncommitted", "base", "commit"].includes(input.mode)) {
    throw new Error(`Invalid review mode: ${String(input.mode)}`);
  }
  if (input.mode === "base" && !input.base) {
    throw new Error('base is required when mode is "base"');
  }
  if (input.mode === "commit" && !input.commit) {
    throw new Error('commit is required when mode is "commit"');
  }
}

async function readOutputFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function buildReviewResult(
  mode: ReviewInput["mode"],
  finalText: string | null,
  meta: ReviewMeta,
  model: string | undefined,
  fallbackUsed: boolean,
  timedOut: boolean,
): ReviewResult {
  return {
    response: finalText ?? "(no review output)",
    model,
    fallbackUsed: fallbackUsed || undefined,
    timedOut,
    mode,
    threadId: meta.threadId,
    meta,
  };
}

function hasReviewEvents(meta: ReviewMeta): boolean {
  return Object.keys(meta.eventCounts).length > 0;
}

function parseReviewOutput(stdout: string, stderr: string): ReviewParseResult {
  const stdoutParsed = parseReviewStream(stdout);
  const stderrParsed = parseReviewStream(stderr);

  // Prefer the stdout parse when it carries the review; otherwise fall back to
  // stderr (older CLI variants), else stdout.
  const primary =
    stdoutParsed.finalText || hasReviewEvents(stdoutParsed.meta)
      ? stdoutParsed
      : stderrParsed.finalText || hasReviewEvents(stderrParsed.meta)
        ? stderrParsed
        : stdoutParsed;

  // A fatal event on the non-selected stream must not be lost. Codex writes
  // failures to stderr in practice, so a turn.failed there while stdout carried
  // only progress events would otherwise let the output-file text return as a
  // successful review.
  if (!primary.meta.fatalError) {
    const other = primary === stdoutParsed ? stderrParsed : stdoutParsed;
    if (other.meta.fatalError) {
      primary.meta.fatalError = other.meta.fatalError;
    }
  }

  return primary;
}
