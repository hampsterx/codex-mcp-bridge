import { join } from "node:path";
import type * as EnvModule from "../../src/utils/env.js";

/**
 * System and managed config paths that never exist, so no unit test reads the
 * host's real /etc/codex. A test that wants system servers passes its own.
 */
export const NO_SYSTEM_CONFIG = {
  system: join(process.cwd(), "tests", "fixtures", "no-system-config", "config.toml"),
  managed: join(process.cwd(), "tests", "fixtures", "no-system-config", "managed_config.toml"),
};

/**
 * A `CODEX_HOME` that never exists. Tool tests set it rather than deleting the
 * variable, which would send any config read to the host's `~/.codex`.
 */
export const NO_CODEX_HOME = join(process.cwd(), "tests", "fixtures", "no-codex-home");

/**
 * The env module with `getMcpServerOverride` defaulting to `NO_SYSTEM_CONFIG`.
 * Tool tests reach it through the tool, which cannot pass the option, so they
 * install this with
 * `vi.mock("../../src/utils/env.js", async (orig) => withoutHostSystemConfig(await orig()))`.
 */
export function withoutHostSystemConfig(env: typeof EnvModule): typeof EnvModule {
  return {
    ...env,
    getMcpServerOverride: (value, options = {}) =>
      env.getMcpServerOverride(value, { systemConfigPaths: NO_SYSTEM_CONFIG, ...options }),
  };
}
