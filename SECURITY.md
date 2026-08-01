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

## Argument Injection

`shell: false` stops shell-level word splitting. It does not stop Codex CLI from
parsing a caller-supplied value as one of its own options, which is a separate
boundary the bridge has to hold on its own.

### The trailing prompt is option-parsed

`codex exec` declares its prompt as an optional trailing positional
(`codex exec [OPTIONS] [PROMPT]`), and the parser reads a dash-prefixed value
there as a flag. Before the fix,
`codex exec --json --sandbox read-only --skip-git-repo-check "--version"`
printed `codex-cli-exec 0.145.0` instead of sending `--version` to the model.

Two things kept that from being remote code execution, and neither is a property
worth depending on:

1. A prompt consumed as a flag leaves no prompt, so Codex falls back to stdin.
   The bridge only uses the positional form when it is *not* piping the prompt,
   so stdin is an empty closed pipe and Codex exits with
   `No prompt provided via stdin` before a session starts.
2. The caller controls exactly one argv token, so it cannot both reconfigure
   Codex and give the agent a task.

Point 1 is one line away from failing. Codex supports a prompt argument *and*
piped stdin together (stdin is appended as a `<stdin>` block), and with stdin
carrying the task a prompt of
`-cmcp_servers={evil={command="touch",args=["/tmp/pwned"]}}` spawns that process.
`-c mcp_servers=` is an unguarded execution primitive: it is not gated by hook
trust, and `--sandbox read-only` does not contain it, because MCP servers are
launched by Codex itself rather than by the sandboxed agent. Config-injected
hooks (`-c hooks=`) are gated, and run only with
`--dangerously-bypass-hook-trust`.

The separator also matters for images: `-i/--image` is variadic on `codex exec`,
so a bare prompt immediately after the last image path is read as another image.

**Mitigation**: `buildArgs` emits `--` before the prompt on both the new and the
resume paths, and `executeStructured` does the same. Verified independently for
`exec` and `exec resume`, which are different parsers.

### Space-form flags reject dash-prefixed values

For `--flag value`, Codex refuses to bind a value that begins with a dash and
fails the whole invocation (`error: a value is required for '--title <TITLE>'
but none was supplied`). It does not silently promote the value to a flag, so
this is a failure mode rather than an injection. It still matters most in
`review`, whose `base`, `commit`, `title`, and `model` are unconstrained caller
strings inside a hardcoded `--full-auto` invocation.

**Mitigation**: `buildReviewArgs` uses `--flag=value`, which binds the value
whatever it starts with.

### `-c key=value` cannot carry a second key

The resume path interpolates the model into `-c model="…"`. Codex parses the
value portion as a single TOML value and ignores anything after it, so
`-c 'model="o3"\nsandbox_mode="danger-full-access"'` sets the model and drops
the second key, while the same key in its own `-c` token does take effect. A
quote breakout degrades the model to a literal string; it does not reach the
sandbox. Model names are therefore not allowlisted: valid ids contain dots and
dashes (`gpt-4.1`, `o3-mini`) and custom-provider names are unbounded.

### Session IDs

Conversation IDs come from Codex output rather than from callers, and are
emitted as the `resume <id>` positional. `isValidSessionId` excludes a leading
dash so an ID can never present as a flag.

## Sandbox Continuity Across Turns

`codex exec resume` inherits its sandbox from user config and project trust when
no sandbox flag is given, which resolves to `workspace-write` inside any
directory the user has trusted. Before the fix the resume path emitted no
sandbox flag, so a caller who requested `read-only` got `read-only` on the first
turn and `workspace-write` on every resumed turn in a trusted repository, with
nothing in the response indicating the change.

`buildArgs` now emits a sandbox level on every path. `--sandbox` and
`--full-auto` are parent `exec` flags, so they are placed before the `resume`
subcommand. An unspecified sandbox resolves to `read-only` inside `buildArgs`
rather than only in the MCP input schema, so a caller reaching the builder
directly cannot fall through to config.

The level is **per request, not sticky**. A resumed turn that wants anything
above `read-only` has to say so; omitting it de-escalates to `read-only`. The
session store deliberately does not persist the sandbox level, because that
would make a single escalation implicitly apply to every later turn on the same
session.

Note that the `codex` tool does not pass `--ignore-user-config`, so
`~/.codex/config.toml` still influences everything the explicit flags do not
cover. The `review` tool does pass it.

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

The `query` tool runs in a temporary directory with `read-only` and `--skip-git-repo-check` for maximum isolation. The `review` tool runs Codex's native `exec review` subcommand in the caller-specified repository with `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `--full-auto`; it does not accept a prompt from the caller.
