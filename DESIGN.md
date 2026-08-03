# Design

Architecture and implementation details for codex-mcp-bridge.

## Architecture

```
MCP Client  --stdio-->  codex-mcp-bridge  --spawn-->  codex CLI subprocess
```

The bridge assembles prompts in TypeScript and spawns the Codex CLI as a subprocess. The `codex` tool can run in `read-only`, `workspace-write`, or `full-auto` sandbox modes; the other prompt-driven tools spawn into isolated read-only contexts. The bridge captures output, parses it, and returns structured MCP responses.

For code review the bridge has no opinion on prompt content. MCP-only clients can use the `review` tool, which wraps upstream `codex exec review --json` without accepting a prompt. Free-form review still goes through the `codex` tool with `sandbox: "read-only"` and a caller-supplied prompt. See [README § Code review with this CLI](README.md#code-review-with-this-cli) and [ADR-001](docs/decisions/001-remove-review-and-assess-tools.md).

## Subprocess Spawning

- Always `spawn()` with `shell: false`, args as array (never `exec()`)
- Large prompts piped via stdin to avoid `ARG_MAX` limits
- Kill process group on timeout: SIGTERM, 5s grace period, then SIGKILL
- `NO_COLOR=1` and `FORCE_COLOR=0` set for every spawn

## Streaming app-server Transport

`mcpStatus` cannot use the spawn path above. That path writes stdin then closes
it, and buffers all stdout into a string until `close`. `codex app-server` needs
the opposite: stdin held open for the session, stdout parsed line-by-line as
JSONL, requests correlated to responses by `id`, and notifications interleaved
throughout. `src/utils/app-server.ts` is therefore a separate subsystem rather
than a flag on `spawnCodex`.

- One `AppServerSession` owns one child and holds **one concurrency slot** for
  its whole lifetime, so introspection competes with `query` / `search` /
  `review` on the same budget. The slot is released exactly once, including on
  spawn failure and repeated `close()`.
- Requests carry their own timeout and drop their pending entry when it fires,
  so a late response cannot resolve a caller that already gave up.
- A dead child turns the next stdin write into an EPIPE `error` event. That is
  handled explicitly: unhandled, it is an uncaught exception that kills the
  whole bridge rather than the one session.
- Teardown is SIGTERM, 5s grace, then SIGKILL, against the process group on
  Unix so the child's own MCP servers go with it.

The protocol is JSON-RPC-shaped but omits `jsonrpc`, and `initialize` requires
only `clientInfo`. It is experimental upstream, so `tests/utils/appserver-schema-drift.test.ts`
regenerates the schema from the installed CLI and diffs the definitions the
bridge parses. See `PLAN_MCP_BOOT_INTROSPECTION.md` for the captured evidence
behind every shape.

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
| `threadId` | string | `review` tool only |
| `eventCounts` | object | `review` tool only |
| `commands` | array | `review` tool only, redacted |

## MCP Annotations

All tools declare [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) so clients can make informed permission and safety decisions:

| Tool | readOnlyHint | destructiveHint | openWorldHint |
|------|-------------|----------------|---------------|
| codex | false | true | true |
| search | true | false | true |
| query | true | false | true |
| review | false | true | true |
| structured | true | false | true |
| ping | true | false | false |
| listSessions | true | false | false |

The `codex` tool is marked destructive because its `workspace-write` and `full-auto` sandbox modes can write files. The `review` tool is also marked destructive because it invokes Codex's native review with `--full-auto` so the non-interactive subprocess can inspect diffs. Most tools are `openWorldHint: true` since they spawn a CLI that can access files and network.

## Progress Notifications

The `codex`, `search`, `query`, and `review` tools emit MCP `notifications/progress` every 15 seconds when the client provides a `progressToken` in the request's `_meta`. Heartbeats include elapsed time. Notifications are fire-and-forget; clients that don't support progress notifications are unaffected.

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

All tools use disable-all by default. The `codex` tool inherits from the `CODEX_MCP_SERVERS` env var; pass `mcpServers: "inherit"` (when supported by upstream) to debug.

### Required servers

Codex PR [#10902](https://github.com/openai/codex/pull/10902) added a `required = true` flag under `[mcp_servers.NAME]`. When set, the bridge refuses to disable that server regardless of `CODEX_MCP_SERVERS` value, and emits a warning to stderr.

### Why per-server enumeration?

A blanket `-c mcp_servers={}` override silently no-ops on older Codex versions: config merging preserves the existing server table rather than replacing it (upstream [openai/codex#16045](https://github.com/openai/codex/issues/16045)). Per-server `enabled=false` is the only reliable disable path.

## Prompt Templates

The `search` and `query` tools load prompt templates from the `prompts/` directory. Templates are filled with placeholders. Editable when running from a local clone; bundled when running via `npx`. The `codex` tool is fully caller-driven: no bridge-side templates.
