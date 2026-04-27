# ADR-001: Code review tool surface

**Status**: Accepted
**Date**: 2026-04-27

## Context

codex-mcp-bridge exposes Codex CLI capabilities to MCP clients. The bridge should
keep prompt ownership clear:

- Caller-authored prompts belong in the general `codex` tool.
- Upstream Codex-owned prompts may be exposed through thin wrappers when they add
  capability that MCP-only clients cannot otherwise reach.

Code review has both shapes:

- Diff-aware native review is owned by upstream Codex.
- Free-form review is caller-authored.

## Decision

Expose code review through two bridge paths:

- `review`: a prompt-free wrapper around upstream `codex exec review --json`.
  It supports native diff selectors (`uncommitted`, `base`, `commit`), requires
  `workingDirectory`, runs ephemerally, and returns the final native review text
  plus redacted execution metadata.
- `codex`: the general prompt-driven tool for free-form review prompts. Callers
  provide the review instructions and any diff or file context they want Codex
  to inspect.

Do not expose an `assess` tool. The bridge does not maintain a review depth
grammar or diff complexity classifier.

## Consequences

- MCP-only clients can run native Codex diff review without shell access.
- The bridge carries no bundled reviewer prompt content.
- Free-form review remains available without duplicating the `codex` tool
  contract under another name.
- Review metadata can include thread IDs, event counts, parse failures, and
  redacted command output, but token usage stays omitted until upstream emits
  reliable usage data.

## Alternatives

- **Only document native `codex review`.** Rejected because MCP-only clients may
  not have shell access.
- **Add a prompt-accepting `review` tool.** Rejected because it duplicates
  `codex` with `sandbox: "read-only"`.
- **Add `assess`.** Rejected because there is no bridge-owned review depth
  grammar for it to target.

## Cross-references

- [README § Code review with this CLI](../../README.md#code-review-with-this-cli)
