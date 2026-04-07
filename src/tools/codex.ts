import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnCodex } from "../utils/spawn.js";
import { parseCodexOutput } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import {
  readFiles,
  assemblePrompt,
  isImageFile,
  MAX_IMAGE_FILE_SIZE,
} from "../utils/files.js";
import { appendLengthLimit } from "../utils/prompts.js";
import { resolveAndVerify, checkFileSize, verifyDirectory, MAX_FILES } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";
import { sessionStore, isValidSessionId } from "../utils/session.js";
import { escapeArg } from "../utils/windows.js";

export interface CodexInput {
  prompt: string;
  files?: string[];
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "full-auto";
  sessionId?: string;
  resetSession?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  workingDirectory?: string;
  timeout?: number;
  maxResponseLength?: number;
}

export interface CodexResult {
  response: string;
  model?: string;
  fallbackUsed?: boolean;
  sessionId?: string;
  conversationId?: string;
  filesIncluded: string[];
  filesSkipped: string[];
  imagesIncluded: string[];
  timedOut: boolean;
}

/** Prompt length threshold for using stdin. */
const STDIN_THRESHOLD = 4000;

/** Default timeout for image queries. */
const IMAGE_QUERY_TIMEOUT = 120_000;

/**
 * Execute a prompt via Codex CLI with optional session support.
 *
 * Arg assembly per plan:
 *   New:    codex exec --model MODEL --sandbox LEVEL --skip-git-repo-check "prompt"
 *   Resume: codex exec --skip-git-repo-check -c model="MODEL" resume CONVERSATION_ID "prompt"
 *   Auto:   codex exec --model MODEL --full-auto --skip-git-repo-check "prompt"
 *
 * cwd is set on spawn (not -C flag, which is broken upstream).
 */
export async function executeCodex(input: CodexInput): Promise<CodexResult> {
  const { prompt, files = [], timeout, maxResponseLength, sandbox, reasoningEffort } = input;
  const model = resolveModel(input.model);

  const cwd = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();

  if (files.length > MAX_FILES) {
    throw new Error(`Too many files: ${files.length} (max ${MAX_FILES})`);
  }

  // Partition files into text and image
  const textFiles = files.filter((f) => !isImageFile(f));
  const imageFiles = files.filter((f) => isImageFile(f));

  // Resolve and verify image paths
  const imageResults = await Promise.all(
    imageFiles.map(async (img) => {
      try {
        const resolved = await resolveAndVerify(img, cwd);
        const size = await checkFileSize(resolved);
        if (size > MAX_IMAGE_FILE_SIZE) {
          return { skipped: `${img}: ${(size / 1024).toFixed(0)}KB exceeds ${(MAX_IMAGE_FILE_SIZE / 1024).toFixed(0)}KB limit` };
        }
        return { resolved, original: img };
      } catch (err) {
        return { skipped: `${img}: ${(err as Error).message}` };
      }
    }),
  );
  const validImages = imageResults.filter(
    (r): r is { resolved: string; original: string } => "resolved" in r,
  );
  const imageNames = validImages.map((r) => r.original);
  const skippedImages = imageResults
    .filter((r): r is { skipped: string } => "skipped" in r)
    .map((r) => r.skipped);

  // Read text files
  const fileContents = textFiles.length > 0 ? await readFiles(textFiles, cwd) : [];
  let fullPrompt = assemblePrompt(prompt, fileContents);

  fullPrompt = appendLengthLimit(fullPrompt, maxResponseLength);

  const useStdin = fullPrompt.length > STDIN_THRESHOLD || files.length > 0;
  const defaultTimeout = imageNames.length > 0 ? IMAGE_QUERY_TIMEOUT : 60_000;
  const effectiveTimeout = Math.min(timeout ?? defaultTimeout, HARD_TIMEOUT_CAP);

  // Reset session if requested: delete stored state so the resume block below is a no-op
  if (input.resetSession && input.sessionId) {
    sessionStore.delete(input.sessionId);
  }

  // Check for session resume (skipped when resetSession is true, since we just deleted it)
  let conversationId: string | undefined;
  if (input.sessionId && !input.resetSession) {
    const session = sessionStore.get(input.sessionId);
    if (session) {
      conversationId = session.conversationId;
    }
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-bridge-"));
  const outputFile = path.join(tempDir, "response.txt");

  try {
    const { result, fallbackUsed, fallbackModel } = await withModelFallback(
      model,
      (m, t) => {
        const args = buildArgs({
          model: m,
          sandbox,
          reasoningEffort,
          conversationId,
          prompt: useStdin ? undefined : fullPrompt,
          outputFile,
          imagePaths: validImages.map((image) => image.resolved),
        });
        return spawnCodex({ args, cwd, stdin: useStdin ? fullPrompt : undefined, timeout: t });
      },
      effectiveTimeout,
    );

    const actualModel = fallbackUsed ? fallbackModel : model;
    const includedFiles = fileContents.filter((f) => !f.skipped).map((f) => f.path);
    const skippedFiles = [
      ...fileContents.filter((f) => f.skipped).map((f) => `${f.path}: ${f.skipped}`),
      ...skippedImages,
    ];

    if (result.timedOut) {
      return {
        response: `Query timed out after ${effectiveTimeout / 1000}s. Try a simpler prompt or increase the timeout.`,
        model: actualModel,
        fallbackUsed: fallbackUsed || undefined,
        filesIncluded: includedFiles,
        filesSkipped: skippedFiles,
        imagesIncluded: imageNames,
        timedOut: true,
      };
    }

    checkErrorPatterns(result.exitCode, result.stderr);

    const parsed = parseCodexOutput(result.stdout, result.stderr);
    const fileResponse = await readOutputFile(outputFile);

    // Store session for resume if we got a thread ID
    let outputSessionId = input.sessionId;
    if (parsed.threadId && isValidSessionId(parsed.threadId)) {
      const sessionId = input.sessionId ?? `codex-${Date.now()}`;
      try {
        const current = sessionStore.get(sessionId);
        sessionStore.set(sessionId, {
          conversationId: parsed.threadId,
          model: actualModel,
          createdAt: current?.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
          turnCount: (current?.turnCount ?? 0) + 1,
        });
        outputSessionId = sessionId;
      } catch {
        // Session storage is best-effort; continue without it
      }
    }

    return {
      response: fileResponse ?? parsed.response,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      sessionId: outputSessionId,
      conversationId: parsed.threadId,
      filesIncluded: includedFiles,
      filesSkipped: skippedFiles,
      imagesIncluded: imageNames,
      timedOut: false,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readOutputFile(filePath: string): Promise<string | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

interface BuildArgsInput {
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "full-auto";
  reasoningEffort?: "low" | "medium" | "high";
  conversationId?: string;
  prompt?: string;
  outputFile?: string;
  imagePaths?: string[];
}

/**
 * Build Codex CLI argument array.
 *
 * New conversation:
 *   codex exec --model MODEL --sandbox LEVEL --skip-git-repo-check "prompt"
 *
 * Resume:
 *   codex exec --skip-git-repo-check -c model="MODEL" resume CONVERSATION_ID "prompt"
 *
 * Full auto (agentic):
 *   codex exec --model MODEL --full-auto --skip-git-repo-check "prompt"
 */
export function buildArgs(input: BuildArgsInput): string[] {
  const { model, sandbox, reasoningEffort, conversationId, prompt, outputFile, imagePaths = [] } = input;
  const args: string[] = ["exec", "--json"];

  if (conversationId) {
    // Resume path: config flags before subcommand args
    args.push("--skip-git-repo-check");
    if (model) args.push("-c", `model="${escapeArg(model)}"`);
    args.push("resume", conversationId);
  } else {
    // New conversation
    if (model) args.push("--model", model);
    if (sandbox === "full-auto") {
      // --full-auto implies sandbox, don't combine with --sandbox
      args.push("--full-auto");
    } else if (sandbox) {
      args.push("--sandbox", sandbox);
    }
    args.push("--skip-git-repo-check");
  }

  // Shared flags for both new and resume paths
  if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  if (outputFile) args.push("-o", outputFile);
  for (const imagePath of imagePaths) {
    args.push("-i", imagePath);
  }

  if (prompt) args.push(prompt);

  return args;
}
