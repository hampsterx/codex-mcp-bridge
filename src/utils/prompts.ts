import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

/**
 * Load a prompt template from prompts/ and replace placeholders.
 * Placeholders use the format {{KEY}}. Only keys present in `vars`
 * are replaced; unknown placeholders pass through unchanged.
 *
 * Uses single-pass regex replacement to prevent user-supplied text
 * (e.g. a DIFF containing `{{LENGTH_LIMIT}}`) from being mutated
 * by later replacement passes.
 */
export function loadPrompt(filename: string, vars: Record<string, string>): string {
  const template = readFileSync(resolve(PROMPTS_DIR, basename(filename)), "utf8");
  const keys = Object.keys(vars);
  if (keys.length === 0) return template;

  const pattern = new RegExp(
    keys.map((k) => `\\{\\{${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}\\}`).join("|"),
    "g",
  );
  return template.replace(pattern, (match) => {
    const key = match.slice(2, -2);
    return vars[key] ?? match;
  });
}

/**
 * Build a length limit instruction string from a word count.
 * Returns empty string when no limit is set.
 */
export function buildLengthLimit(maxWords?: number): string {
  if (!maxWords || maxWords <= 0) return "";
  return `Keep your response under ${maxWords} words.`;
}

/**
 * Append a length limit instruction to a prompt string.
 * No-op when maxWords is not set.
 */
export function appendLengthLimit(prompt: string, maxWords?: number): string {
  const limit = buildLengthLimit(maxWords);
  return limit ? `${prompt}\n\n${limit}` : prompt;
}
