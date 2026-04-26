# Security

Security model and hardening measures for codex-mcp-bridge.

## Environment Isolation

The subprocess receives only an explicit allowlist of environment variables. All env vars outside this list are stripped, preventing unintended credential leakage. The allowlist includes the OpenAI auth keys required by Codex CLI.

**Allowed keys**: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `CODEX_HOME`, `CODEX_DEFAULT_MODEL`, `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `XDG_CONFIG_HOME`

**Always set**: `NO_COLOR=1`, `FORCE_COLOR=0`

Everything else from `process.env` is stripped. The allowlist is defined in `src/utils/env.ts`. Note that `OPENAI_API_KEY` is explicitly listed (unlike generic `OPENAI_*` prefix matching) so only the specific key required by Codex is forwarded.

## Path Sandboxing

All file paths are resolved to absolute paths via `realpath()` and verified to stay within the working directory:

- No path traversal via `..` components
- No symlink following outside the root directory
- Paths outside the sandbox are rejected before reaching the CLI

## Subprocess Safety

- Subprocess spawned with `shell: false` and args as an array. No command injection from the bridge itself.
- Large prompts piped via stdin rather than passed as command-line arguments.
- Process groups killed on timeout (SIGTERM then SIGKILL after 5s grace period).

## Output Redaction

CLI output is scanned for sensitive patterns before being returned to the MCP client:

- Anthropic/OpenAI API keys (`sk-ant-*`, `sk-*`)
- Bearer tokens
- Token assignments in output
- Base64-encoded strings that resemble secrets

Matches are replaced with `[REDACTED]`.

## Resource Limits

| Limit | Value |
|-------|-------|
| Max file size (text) | 1 MB |
| Max file size (image) | 5 MB |
| Max files per request | 20 |
| Max JSON Schema size | 20 KB |
| Max concurrent spawns | 3 (configurable) |
| Queue timeout | 30s |
| Hard timeout cap | 600s (10 min) |

## Sandbox Modes

The `codex` tool exposes Codex CLI's sandbox levels as a parameter:

| Mode | Description |
|------|-------------|
| `read-only` | No file writes (default; recommended for code review) |
| `workspace-write` | Writes only within working directory |
| `full-auto` | Full file system access (opt in only when callers need it) |

The `query` tool runs in a temporary directory with `read-only` and `--skip-git-repo-check` for maximum isolation.
