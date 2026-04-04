/**
 * Windows-specific argument escaping for cmd.exe.
 * From Phase 1 of the plan: handle Windows from day 1.
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
