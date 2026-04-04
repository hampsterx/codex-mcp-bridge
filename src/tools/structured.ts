import _Ajv from "ajv";
import { spawnCodex } from "../utils/spawn.js";
import { parseCodexOutput, extractJson } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { readFiles, assemblePrompt, isImageFile } from "../utils/files.js";
import { verifyDirectory, MAX_FILES } from "../utils/security.js";
import { loadPrompt } from "../utils/prompts.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";

// Ajv's CJS/ESM interop wraps the constructor in a default property at runtime
const Ajv = _Ajv.default ?? _Ajv;

/** Maximum schema size in bytes (20KB). */
export const MAX_SCHEMA_SIZE = 20_000;

/** Prompt length threshold for using stdin. */
const STDIN_THRESHOLD = 4000;

/**
 * Create a fresh Ajv instance per validation to avoid schema caching conflicts.
 */
function createAjv() {
  return new Ajv({ allErrors: true });
}

export interface StructuredInput {
  prompt: string;
  schema: string;
  files?: string[];
  model?: string;
  workingDirectory?: string;
  timeout?: number;
}

export interface StructuredResult {
  response: string;
  valid: boolean;
  errors?: string;
  model?: string;
  fallbackUsed?: boolean;
  filesIncluded: string[];
  filesSkipped: string[];
  timedOut: boolean;
}

/**
 * Execute a structured output query against Codex CLI.
 * Embeds the JSON schema in the prompt and validates the response.
 */
export async function executeStructured(input: StructuredInput): Promise<StructuredResult> {
  const { prompt, files = [], timeout } = input;
  const model = resolveModel(input.model);

  if (input.schema.length > MAX_SCHEMA_SIZE) {
    throw new Error(`Schema too large: ${input.schema.length} bytes (max ${MAX_SCHEMA_SIZE})`);
  }

  let parsedSchema: object;
  try {
    parsedSchema = JSON.parse(input.schema) as object;
  } catch {
    throw new Error("Invalid schema: not valid JSON");
  }

  const ajv = createAjv();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let validate: any;
  try {
    validate = ajv.compile(parsedSchema);
  } catch (e: unknown) {
    throw new Error(`Invalid JSON Schema: ${(e as Error).message}`);
  }

  const imageFiles = files.filter((f) => isImageFile(f));
  if (imageFiles.length > 0) {
    throw new Error("Structured tool does not support image files (text only)");
  }

  if (files.length > MAX_FILES) {
    throw new Error(`Too many files: ${files.length} (max ${MAX_FILES})`);
  }

  const cwd = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();

  const fileContents = files.length > 0 ? await readFiles(files, cwd) : [];

  const canonicalSchema = JSON.stringify(parsedSchema, null, 2);
  const templatePrompt = loadPrompt("structured.md", {
    SCHEMA: canonicalSchema,
    PROMPT: prompt,
  });
  const fullPrompt = assemblePrompt(templatePrompt, fileContents);

  const useStdin = fullPrompt.length > STDIN_THRESHOLD || files.length > 0;
  const effectiveTimeout = Math.min(timeout ?? 60_000, HARD_TIMEOUT_CAP);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = ["exec"];
      if (m) args.push("--model", m);
      args.push("--sandbox", "read-only", "--skip-git-repo-check");
      if (!useStdin) args.push(fullPrompt);
      return spawnCodex({ args, cwd, stdin: useStdin ? fullPrompt : undefined, timeout: t });
    },
    effectiveTimeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;
  const includedFiles = fileContents.filter((f) => !f.skipped).map((f) => f.path);
  const skippedFiles = fileContents.filter((f) => f.skipped).map((f) => `${f.path}: ${f.skipped}`);

  if (result.timedOut) {
    return {
      response: `Structured query timed out after ${effectiveTimeout / 1000}s.`,
      valid: false,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: includedFiles,
      filesSkipped: skippedFiles,
      timedOut: true,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseCodexOutput(result.stdout, result.stderr);

  const extracted = extractJson(parsed.response);
  if (!extracted) {
    return {
      response: parsed.response,
      valid: false,
      errors: "Could not extract JSON from response",
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: includedFiles,
      filesSkipped: skippedFiles,
      timedOut: false,
    };
  }

  const valid = validate(extracted.json);
  if (!valid) {
    const errors = (validate.errors as Array<{ instancePath?: string; message?: string }> | null)
      ?.map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    return {
      response: extracted.raw,
      valid: false,
      errors,
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      filesIncluded: includedFiles,
      filesSkipped: skippedFiles,
      timedOut: false,
    };
  }

  return {
    response: extracted.raw,
    valid: true,
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    filesIncluded: includedFiles,
    filesSkipped: skippedFiles,
    timedOut: false,
  };
}
