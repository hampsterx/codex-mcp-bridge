# ADR-001: Remove `review` and `assess` tools

**Status**: Accepted
**Date**: 2026-04-26

## Context

This bridge registers `codex` (caller-supplied prompt, configurable sandbox, wraps `codex exec`), `query`, `search`, `structured`, `listSessions`, `ping`, plus `review` (bundled reviewer prompts, depth selector) and `assess` (computes diff stats, classifies complexity, recommends a `review` depth).

CLI-wrapping tools should accept caller-supplied prompts rather than bundle them: prompts iterate fast, bridges publish slowly. The bridge keeps that boundary in `codex`; `review` crosses it by bundling prompt content that should not live in the bridge.

## Decision

Drop `review` and `assess`.

Code review through this bridge uses:

- Native upstream `codex review --base <branch>` (diff-aware, called directly). MCP clients that cannot reach the CLI directly fall back to the bridge `codex` path below.
- The bridge's `codex` tool with `sandbox: "read-only"` and a caller-supplied prompt that includes both review instructions and the diff (or file references). Diff-awareness is the caller's responsibility on this path; `codex exec` does not infer it.

`assess`'s role is selecting a `review` depth and emitting time estimates calibrated to that depth grammar. Without `review`, those recommendations have no consumer.

Both review paths are documented in [README § Code review with this CLI](../../README.md#code-review-with-this-cli).

## Alternatives considered

- **Keep `review` with caller-supplied prompts.** Functionally equivalent to `codex` with `sandbox: "read-only"`; two tools sharing one contract differ only in name.
- **Keep `assess` as a standalone diff classifier.** Its public surface is calibrated to `review`'s depth grammar; without that consumer, the recommendations are unanchored.
- **Keep `review` as a thin "review-preset" wrapper.** Defaults it would set (sandbox, timeout) are caller decisions; the bridge has no information the caller does not.

## Cross-references

- README § Code review with this CLI
