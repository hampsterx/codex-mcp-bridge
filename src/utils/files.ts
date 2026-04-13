import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  resolveAndVerify,
  checkFileSize,
  MAX_FILE_SIZE,
  MAX_FILES,
} from "./security.js";
import { toErrorMessage } from "./errors.js";

/** Maximum file size for image files (5MB). */
export const MAX_IMAGE_FILE_SIZE = 5_000_000;

/** Extensions treated as image files (binary, passed by path to CLI). */
export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
]);

/**
 * Check whether a file path refers to an image based on extension.
 */
export function isImageFile(filePath: string): boolean {
  const stripped = filePath.replace(/:\d+-\d+$/, "");
  return IMAGE_EXTENSIONS.has(path.extname(stripped).toLowerCase());
}

export interface FileSpec {
  path: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Parse a file specifier that may include a line range.
 *
 * Supported formats:
 * - `"src/lib.rs"` - full file
 * - `"src/lib.rs:900-950"` - lines 900 to 950 (1-based, inclusive)
 *
 * Windows paths with drive letters (e.g. `C:\foo\bar.ts:10-20`) are handled
 * by only matching a trailing `:digits-digits` pattern.
 */
export function parseFileSpec(spec: string): FileSpec {
  const match = spec.match(/:(\d+)-(\d+)$/);
  if (!match) return { path: spec };

  const startLine = parseInt(match[1]!, 10);
  const endLine = parseInt(match[2]!, 10);
  const filePath = spec.slice(0, match.index!);

  if (startLine < 1) {
    throw new Error(`Invalid line range in "${spec}": start must be >= 1`);
  }
  if (startLine > endLine) {
    throw new Error(`Invalid line range in "${spec}": start (${startLine}) > end (${endLine})`);
  }

  return { path: filePath, startLine, endLine };
}

export interface FileContent {
  path: string;
  content: string;
  skipped?: string;
  /** Header label for the assembled prompt (includes range info if applicable). */
  label?: string;
}

/**
 * Read multiple files with path sandboxing and size limits.
 * Supports line range specifiers: `"path:start-end"`.
 */
export async function readFiles(
  files: string[],
  rootDir: string,
): Promise<FileContent[]> {
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files: ${files.length} (max ${MAX_FILES})`);
  }

  return Promise.all(
    files.map(async (f): Promise<FileContent> => {
      try {
        const spec = parseFileSpec(f);
        const resolved = await resolveAndVerify(spec.path, rootDir);
        const size = await checkFileSize(resolved);

        if (size > MAX_FILE_SIZE) {
          return {
            path: f,
            content: "",
            skipped: `${(size / 1024).toFixed(0)}KB exceeds ${(MAX_FILE_SIZE / 1024).toFixed(0)}KB limit`,
          };
        }

        const content = await readFile(resolved, "utf8");

        if (spec.startLine != null && spec.endLine != null) {
          const lines = content.split("\n");
          // Drop trailing empty element from files ending with \n (most source files)
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          const totalLines = lines.length;
          const start = Math.min(spec.startLine - 1, totalLines); // 0-based, clamp to EOF
          const end = Math.min(spec.endLine, totalLines); // clamp to file length
          const sliced = lines.slice(start, end).join("\n");
          const regionLines = Math.max(0, end - start);
          const clampedStart = Math.min(spec.startLine, totalLines);
          const clampedEnd = Math.min(spec.endLine, totalLines);
          const label = regionLines === 0
            ? `${spec.path}:${spec.startLine}-${spec.endLine} (requested range past ${totalLines}-line file)`
            : `${spec.path}:${clampedStart}-${clampedEnd} (${regionLines} of ${totalLines} lines)`;
          return {
            path: f,
            content: sliced,
            label,
          };
        }

        return { path: f, content };
      } catch (err) {
        return {
          path: f,
          content: "",
          skipped: toErrorMessage(err),
        };
      }
    }),
  );
}

/**
 * Assemble a prompt with file contents.
 */
export function assemblePrompt(prompt: string, fileContents: FileContent[]): string {
  if (fileContents.length === 0) return prompt;

  const parts = fileContents.map((f) => {
    const header = f.label ?? f.path;
    if (f.skipped) {
      return `--- ${header} ---\n[SKIPPED: ${f.skipped}]`;
    }
    return `--- ${header} ---\n${f.content}`;
  });

  return `${prompt}\n\n${parts.join("\n\n")}`;
}
