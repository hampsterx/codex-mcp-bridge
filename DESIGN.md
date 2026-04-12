# Design

Architecture and implementation details for codex-mcp-bridge.

## Architecture

```
MCP Client  --stdio-->  codex-mcp-bridge  --spawn-->  codex CLI subprocess
```

The bridge assembles prompts in TypeScript and spawns the Codex CLI as a subprocess. The `review` tool's agentic mode runs Codex in `--full-auto` inside the target repo, letting it explore files, follow imports, and read project instruction files. The bridge captures output, parses it, and returns structured MCP responses.

## Subprocess Spawning

- Always `spawn()` with `shell: false`, args as array (never `exec()`)
- Large prompts piped via stdin to avoid `ARG_MAX` limits
- Kill process group on timeout: SIGTERM, 5s grace period, then SIGKILL
- `NO_COLOR=1` and `FORCE_COLOR=0` set for every spawn

## Output Parsing

Multi-strategy parsing with cascading fallback:

1. **JSONL events** (stdout primary, stderr fallback): Codex emits structured events during execution
2. **JSON parsing**: Falls back to parsing the full output as JSON
3. **Plain text**: Last resort, returns raw text output

The parser tolerates malformed JSON and extracts response text from partial output. Potential secrets (API keys, Bearer tokens) are redacted from CLI output before being returned.

## Concurrency

Requests are managed by a FIFO queue:
- **Max concurrent**: 3 subprocess spawns (configurable via `CODEX_MAX_CONCURRENT`)
- **Queue timeout**: 30s (requests that can't acquire a slot within 30s are rejected)
- **Timeout enforcement**: Per-tool defaults, 600s (10 min) hard cap
- **Cleanup**: Timed-out processes killed with SIGTERM, then SIGKILL after 5s. On Unix, the entire process group is killed to clean up child processes.

## Model Fallback

When the primary model returns a quota exhaustion error, the bridge automatically retries with `CODEX_FALLBACK_MODEL` (default: `o3`). Set to `none` to disable. The `_meta.fallbackUsed` field indicates whether fallback was triggered.

## Sessions

Session state is tracked in-memory across calls. When the `codex` tool returns a `sessionId` in `_meta`, pass it back on subsequent calls to resume the conversation. Codex's native `conversationId` is captured from stderr and used for `codex exec resume`.

- **TTL**: 24 hours of inactivity
- **Capacity**: LRU eviction at 100 sessions
- **Reset**: Pass `resetSession: true` to discard stored state
- **Listing**: The `listSessions` tool exposes session metadata (id, model, timestamps, turn count)
- **Ephemeral**: Session state is in-memory only, lost on server restart

## Response Metadata

All tools attach an `_meta` object to the MCP `CallToolResult`:

| Field | Type | Present on |
|-------|------|------------|
| `durationMs` | number | All tools |
| `model` | string | Tools that run Codex CLI |
| `fallbackUsed` | boolean | Tools that run Codex CLI |
| `sessionId` | string | `codex` tool only |
| `conversationId` | string | `codex` tool only |

## MCP Annotations

All tools declare [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) so clients can make informed permission and safety decisions:

| Tool | readOnlyHint | destructiveHint | openWorldHint |
|------|-------------|----------------|---------------|
| codex | false | true | true |
| review | false | true | true |
| search | true | false | true |
| query | true | false | true |
| structured | true | false | true |
| ping | true | false | false |
| listSessions | true | false | false |

The `codex` and `review` tools are marked destructive because full-auto sandbox mode can write files. Most tools are `openWorldHint: true` since they spawn a CLI that can access files and network.

## Progress Notifications

The `codex`, `review`, `search`, and `query` tools emit MCP `notifications/progress` every 15 seconds when the client provides a `progressToken` in the request's `_meta`. Heartbeats include elapsed time. Notifications are fire-and-forget; clients that don't support progress notifications are unaffected.

Implemented in `src/utils/progress.ts`.

## Codex Internal MCP Server Control

When the bridge spawns Codex, any MCP servers configured in `~/.codex/config.toml` (`[mcp_servers.*]`) would otherwise load inside Codex and add 30-120s of startup overhead per call. The `CODEX_MCP_SERVERS` env var controls which servers stay enabled.

### Grammar

Branches evaluated top-to-bottom:

| Mode | Value | Behavior |
|------|-------|----------|
| **Disable-all** (default) | unset / empty / whitespace | Disable every configured server except those marked `required = true` |
| **Inherit** | `inherit` (exact, case-sensitive) | Pass through config unchanged |
| **Raw TOML** | value starting with `{` or `[` | Forwarded verbatim as `-c mcp_servers=<value>` |
| **Selective enable** | comma-separated names | Enable listed servers, disable all others (except required) |

### Per-tool defaults

The `review` tool's agentic mode defaults to `CODEX_MCP_SERVERS=serena` so symbol navigation is available during review. Pass the `mcpServers` tool parameter to override per-invocation (e.g. `"ck-search,serena"` for deeper review, or `"inherit"` to debug). Quick review mode and all other tools use disable-all.

### Required servers

Codex PR [#10902](https://github.com/openai/codex/pull/10902) added a `required = true` flag under `[mcp_servers.NAME]`. When set, the bridge refuses to disable that server regardless of `CODEX_MCP_SERVERS` value, and emits a warning to stderr.

### Why per-server enumeration?

A blanket `-c mcp_servers={}` override silently no-ops on older Codex versions: config merging preserves the existing server table rather than replacing it (upstream [openai/codex#16045](https://github.com/openai/codex/issues/16045)). Per-server `enabled=false` is the only reliable disable path.

## Prompt Templates

The `review`, `search`, and `query` tools load prompt templates from the `prompts/` directory. Templates are filled with placeholders (diff content, focus area, etc.). Editable when running from a local clone; bundled when running via `npx`.

## Review Timeouts

The `review` tool uses static defaults: 300s for agentic mode, 120s for quick mode, with a 600s hard cap. A caller-supplied `timeout` parameter always takes precedence.

Unlike gemini-mcp-bridge, codex-mcp-bridge does not yet auto-scale timeouts from diff size (Codex CLI's fast startup makes this less critical).
