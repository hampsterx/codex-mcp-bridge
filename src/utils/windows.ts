/**
 * Windows-specific argument escaping.
 *
 * NOTE: The bridge spawns Codex CLI with `shell: false`, which means
 * arguments are passed directly to the process via CreateProcessW on
 * Windows (no cmd.exe interpretation). The cmd.exe escaping below
 * (%→%%, "→"") is therefore unnecessary for the bridge's own spawns.
 *
 * However, the escaped values end up inside `-c key="value"` Codex CLI
 * config flags, where the CLI itself may re-parse them. Removing the
 * escaping requires verifying Codex CLI's config flag parsing on
 * Windows, which is untested. Keeping the escaping as a defensive
 * measure until Windows CI coverage is added.
 *
 * Missing coverage: cmd.exe metacharacters (^, &, |, <, >, !) are not
 * escaped. Again, irrelevant with shell: false, but worth noting if
 * the spawn strategy ever changes.
 */

/**
 * Escape a string for use as a cmd.exe argument.
 * - `%` -> `%%` (environment variable expansion)
 * - `"` -> `""` (quote escaping in cmd.exe)
 */
export function escapeForCmd(arg: string): string {
  return arg.replace(/%/g, "%%").replace(/"/g, '""');
}

/**
 * Check if the current platform is Windows.
 */
export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Conditionally escape arguments for Windows.
 * On non-Windows platforms, returns the argument unchanged.
 */
export function escapeArg(arg: string): string {
  return isWindows() ? escapeForCmd(arg) : arg;
}
