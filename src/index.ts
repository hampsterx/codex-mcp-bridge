#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeCodex } from "./tools/codex.js";
import { executeSearch } from "./tools/search.js";
import { executeQuery } from "./tools/query.js";
import { executeReview } from "./tools/review.js";
import { executePing } from "./tools/ping.js";
import { executeStructured } from "./tools/structured.js";
import {
  codexAnnotations,
  searchAnnotations,
  queryAnnotations,
  reviewAnnotations,
  structuredAnnotations,
  listSessionsAnnotations,
  pingAnnotations,
} from "./annotations.js";
import { sessionStore } from "./utils/session.js";
import { buildMeta } from "./utils/meta.js";
import { toErrorMessage } from "./utils/errors.js";
import { maybeStartHeartbeat, type ProgressNotificationSender } from "./utils/progress.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "codex-mcp-bridge",
  version: PKG_VERSION,
});

// --- codex tool ---

server.registerTool(
  "codex",
  {
    title: "Codex CLI",
    description: `Execute a prompt via Codex CLI. Codex is an AI coding agent that can generate, analyze, refactor, and explain code with full project context (reads AGENTS.md/CODEX.md automatically).

Capabilities: code generation and refactoring, code analysis and explanation, file reading and modification (when sandbox allows), git operations and terminal commands, multi-turn conversations via sessionId.

When to use a different tool:
- For analysis of text you already have (plans, docs, opinions), inline it directly in the prompt rather than passing file paths. The files parameter triggers full file I/O and increases timeout pressure.

Tips:
- Set workingDirectory to the target repo for project-aware responses.
- Use sandbox "read-only" (default) for analysis, "full-auto" for code changes.
- Break complex tasks into focused prompts rather than one large request.
- Resume multi-turn conversations with sessionId (returned in previous response metadata).
- Include relevant files via the files parameter for targeted context (text and images supported).
- Set reasoningEffort to control depth: "none" for trivial, "minimal" for lightweight, "low"/"medium" for routine, "high"/"xhigh" for deep analysis.`,
    inputSchema: {
      prompt: z.string().describe("The prompt to send to Codex"),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths relative to workingDirectory. Supports line ranges: 'path:start-end' (e.g. 'src/lib.rs:900-950'). Text and images supported (images ignore line ranges)."),
      model: z.string().optional().describe("Model to use (e.g. o3, gpt-4.1)"),
      sandbox: z
        .enum(["read-only", "workspace-write", "full-auto"])
        .default("read-only")
        .describe("Sandbox level: read-only (default), workspace-write, or full-auto (Codex CLI convenience mode for workspace-write with auto-approve)"),
      sessionId: z
        .string()
        .optional()
        .describe("Session ID to resume a previous conversation"),
      resetSession: z
        .boolean()
        .optional()
        .describe("Clear this session's conversation history and start fresh (requires sessionId)"),
      reasoningEffort: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
        .optional()
        .describe("Reasoning effort level (maps to -c model_reasoning_effort)"),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory for the CLI"),
      timeout: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Timeout in milliseconds (default: 60s no files, 180s+30s/file with files, max: 600000)"),
      maxResponseLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Soft limit on response length in words"),
    },
    annotations: codexAnnotations,
  },
  async (input, extra) => {
    const startTime = Date.now();
    const heartbeat = maybeStartHeartbeat(
      extra._meta as { progressToken?: string | number } | undefined,
      extra.sendNotification as ProgressNotificationSender,
    );
    try {
      const result = await executeCodex(input);
      const durationMs = Date.now() - startTime;

      const meta: string[] = [];
      if (result.filesIncluded.length > 0) {
        meta.push(`Files included: ${result.filesIncluded.join(", ")}`);
      }
      if (result.imagesIncluded.length > 0) {
        meta.push(`Images included: ${result.imagesIncluded.join(", ")}`);
      }
      if (result.filesSkipped.length > 0) {
        meta.push(`Files skipped: ${result.filesSkipped.join(", ")}`);
      }
      if (result.timedOut) {
        meta.push("(timed out)");
      }
      if (result.fallbackUsed) {
        meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion`);
      } else if (result.model) {
        meta.push(`Model: ${result.model}`);
      }
      if (result.sessionId) {
        meta.push(`Session: ${result.sessionId}`);
      }
      if (result.conversationId) {
        meta.push(`Conversation: ${result.conversationId}`);
      }

      const text = meta.length > 0
        ? `${result.response}\n\n---\n${meta.join("\n")}`
        : result.response;

      return {
        content: [{ type: "text" as const, text }],
        _meta: buildMeta({
          model: result.model,
          durationMs,
          fallbackUsed: result.fallbackUsed,
          sessionId: result.sessionId,
          conversationId: result.conversationId,
        }),
      };
    } catch (e) {
      const durationMs = Date.now() - startTime;
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(e)}` }],
        isError: true,
        _meta: buildMeta({ durationMs }),
      };
    } finally {
      heartbeat.stop();
    }
  },
);

// --- search tool ---

server.registerTool(
  "search",
  {
    title: "Web Search",
    description: `Web search via Codex CLI. Searches the web and synthesizes a comprehensive answer with source URLs. Use for current information, documentation lookups, API references, and research questions.

Tips:
- Ask specific, focused questions for best results.
- Results include source URLs for verification.
- Use maxResponseLength to control response verbosity.
- Default timeout is 2 minutes; increase for complex research queries that may require multiple web fetches.`,
    inputSchema: {
      query: z.string().describe("Search query or question"),
      model: z.string().optional().describe("Model to use (e.g. o3, gpt-4.1)"),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory for the CLI"),
      timeout: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Timeout in milliseconds (default: 120000, max: 600000)"),
      maxResponseLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Soft limit on response length in words"),
    },
    annotations: searchAnnotations,
  },
  async (input, extra) => {
    const startTime = Date.now();
    const heartbeat = maybeStartHeartbeat(
      extra._meta as { progressToken?: string | number } | undefined,
      extra.sendNotification as ProgressNotificationSender,
    );
    try {
      const result = await executeSearch(input);
      const durationMs = Date.now() - startTime;

      const meta: string[] = [];
      if (result.timedOut) meta.push("(timed out)");
      if (result.fallbackUsed) {
        meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion`);
      } else if (result.model) {
        meta.push(`Model: ${result.model}`);
      }

      const text = meta.length > 0
        ? `${result.response}\n\n---\n${meta.join("\n")}`
        : result.response;

      return {
        content: [{ type: "text" as const, text }],
        _meta: buildMeta({
          model: result.model,
          durationMs,
          fallbackUsed: result.fallbackUsed,
        }),
      };
    } catch (e) {
      const durationMs = Date.now() - startTime;
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(e)}` }],
        isError: true,
        _meta: buildMeta({ durationMs }),
      };
    } finally {
      heartbeat.stop();
    }
  },
);

// --- query tool ---

server.registerTool(
  "query",
  {
    title: "Quick Query",
    description: `Lightweight query for analysis or opinions on text you already have. No file reading, no repo exploration, no session state. Pass text in the context parameter. For code execution or file operations, use the codex tool instead.

Use cases: reviewing a plan, critiquing a draft, comparing approaches, answering questions about provided text, generating summaries.

Tips:
- Pass the text to analyze in the context parameter, not as file paths.
- Set reasoningEffort to control depth: "none" for trivial, "minimal" for lightweight, "low"/"medium" for routine, "high"/"xhigh" for thorough analysis.
- Use maxResponseLength to control verbosity.`,
    inputSchema: {
      prompt: z.string().describe("The question or instruction"),
      context: z
        .string()
        .optional()
        .describe("Text to analyze (inline, not file paths)"),
      model: z.string().optional().describe("Model to use (e.g. o3, gpt-4.1)"),
      reasoningEffort: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
        .optional()
        .describe("Reasoning effort level (maps to -c model_reasoning_effort)"),
      timeout: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Timeout in milliseconds (default: 60000, max: 600000)"),
      maxResponseLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Soft limit on response length in words"),
    },
    annotations: queryAnnotations,
  },
  async (input, extra) => {
    const startTime = Date.now();
    const heartbeat = maybeStartHeartbeat(
      extra._meta as { progressToken?: string | number } | undefined,
      extra.sendNotification as ProgressNotificationSender,
    );
    try {
      const result = await executeQuery(input);
      const durationMs = Date.now() - startTime;

      const meta: string[] = [];
      if (result.timedOut) meta.push("(timed out)");
      if (result.fallbackUsed) {
        meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion`);
      } else if (result.model) {
        meta.push(`Model: ${result.model}`);
      }

      const text = meta.length > 0
        ? `${result.response}\n\n---\n${meta.join("\n")}`
        : result.response;

      return {
        content: [{ type: "text" as const, text }],
        _meta: buildMeta({
          model: result.model,
          durationMs,
          fallbackUsed: result.fallbackUsed,
        }),
      };
    } catch (e) {
      const durationMs = Date.now() - startTime;
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(e)}` }],
        isError: true,
        _meta: buildMeta({ durationMs }),
      };
    } finally {
      heartbeat.stop();
    }
  },
);

// --- review tool ---

server.registerTool(
  "review",
  {
    title: "Native Code Review",
    description: `Run Codex CLI's native diff-aware review via codex exec review --json. The bridge does not accept or bundle a review prompt; upstream Codex owns the reviewer instructions.

Use for MCP clients that cannot run shell commands but need native Codex review of uncommitted changes, a base branch diff, or a single commit.

Tips:
- Set workingDirectory to the target git repository.
- Choose mode "uncommitted", "base", or "commit".
- Use the codex tool with sandbox "read-only" for free-form review prompts.`,
    inputSchema: {
      mode: z
        .enum(["uncommitted", "base", "commit"])
        .describe("Diff selector: uncommitted changes, changes against a base branch, or one commit"),
      base: z
        .string()
        .optional()
        .describe('Base branch or ref. Required when mode is "base".'),
      commit: z
        .string()
        .optional()
        .describe('Commit SHA or ref. Required when mode is "commit".'),
      title: z
        .string()
        .optional()
        .describe("Optional commit title to display in the review summary"),
      model: z.string().optional().describe("Model to use (e.g. o3, gpt-4.1)"),
      workingDirectory: z
        .string()
        .describe("Target git repository directory for native review"),
      timeout: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Timeout in milliseconds (default: 180000, max: 600000)"),
    },
    annotations: reviewAnnotations,
  },
  async (input, extra) => {
    const startTime = Date.now();
    const heartbeat = maybeStartHeartbeat(
      extra._meta as { progressToken?: string | number } | undefined,
      extra.sendNotification as ProgressNotificationSender,
    );
    try {
      const result = await executeReview(input);
      const durationMs = Date.now() - startTime;

      const meta: string[] = [];
      if (result.timedOut) meta.push("(timed out)");
      if (result.fallbackUsed) {
        meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion`);
      } else if (result.model) {
        meta.push(`Model: ${result.model}`);
      }
      if (result.threadId) meta.push(`Thread: ${result.threadId}`);
      if (result.meta.parseFailures > 0) {
        meta.push(`Parse failures: ${result.meta.parseFailures}`);
      }

      const text = meta.length > 0
        ? `${result.response}\n\n---\n${meta.join("\n")}`
        : result.response;

      return {
        content: [{ type: "text" as const, text }],
        _meta: {
          ...buildMeta({
            model: result.model,
            durationMs,
            fallbackUsed: result.fallbackUsed,
          }),
          mode: result.mode,
          eventCounts: result.meta.eventCounts,
          parseFailures: result.meta.parseFailures,
          commands: result.meta.commands,
          threadId: result.threadId,
        },
      };
    } catch (e) {
      const durationMs = Date.now() - startTime;
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(e)}` }],
        isError: true,
        _meta: buildMeta({ durationMs }),
      };
    } finally {
      heartbeat.stop();
    }
  },
);

// --- structured tool ---

server.registerTool(
  "structured",
  {
    title: "Structured Output",
    description: "Generate a JSON response conforming to a provided JSON Schema. Use for data extraction, classification, or any task needing machine-parseable output.",
    inputSchema: {
      prompt: z.string().describe("What to generate or extract"),
      schema: z
        .string()
        .describe("JSON Schema the response must conform to (as a JSON string)"),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to include as context (text only, no images). Supports line ranges: 'path:start-end' (e.g. 'src/lib.rs:900-950')."),
      model: z
        .string()
        .optional()
        .describe("Model to use (e.g. o3, gpt-4.1)"),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory for file paths"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in milliseconds (default: 60000)"),
    },
    annotations: structuredAnnotations,
  },
  async (input) => {
    const startTime = Date.now();
    try {
      const result = await executeStructured(input);
      const durationMs = Date.now() - startTime;

      const meta: string[] = [];
      if (result.errors) meta.push(`Errors: ${result.errors}`);
      if (result.filesIncluded.length > 0) {
        meta.push(`Files: ${result.filesIncluded.join(", ")}`);
      }
      if (result.timedOut) meta.push("(timed out)");
      if (result.fallbackUsed) {
        meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion`);
      } else if (result.model) {
        meta.push(`Model: ${result.model}`);
      }

      const metaSuffix = meta.length > 0 ? `\n\n---\n${meta.join("\n")}` : "";

      return {
        content: [{
          type: "text" as const,
          text: result.valid
            ? `${result.response}${metaSuffix}`
            : `${result.response}\n\n---\nSchema validation failed. ${meta.join("\n")}`,
        }],
        isError: !result.valid,
        _meta: buildMeta({
          model: result.model,
          durationMs,
          fallbackUsed: result.fallbackUsed,
        }),
      };
    } catch (e) {
      const durationMs = Date.now() - startTime;
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(e)}` }],
        isError: true,
        _meta: buildMeta({ durationMs }),
      };
    }
  },
);

// --- listSessions tool ---

server.registerTool(
  "listSessions",
  {
    title: "List Sessions",
    description: "List active Codex conversation sessions. Returns session metadata for orchestration (no prompts or responses, just IDs and timing). Use to check available sessions before resuming with the codex tool's sessionId parameter.",
    inputSchema: {},
    annotations: listSessionsAnnotations,
  },
  async () => {
    const startTime = Date.now();
    const sessions = sessionStore.list().map(({ sessionId, entry }) => ({
      sessionId,
      conversationId: entry.conversationId,
      model: entry.model,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
      turnCount: entry.turnCount,
    }));

    const durationMs = Date.now() - startTime;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(sessions, null, 2),
      }],
      _meta: buildMeta({ durationMs }),
    };
  },
);

// --- ping tool ---

server.registerTool(
  "ping",
  {
    title: "Health Check",
    description: "Health check: verifies Codex CLI is installed and authenticated, reports versions and capabilities.",
    inputSchema: {},
    annotations: pingAnnotations,
  },
  async () => {
    const startTime = Date.now();
    try {
      const result = await executePing();
      const durationMs = Date.now() - startTime;

      const modelsSummary = result.supportedModels
        .map((m) => `${m.id} (${m.tier}${m.isDefault ? ", default" : ""})`)
        .join(", ");

      const lines = [
        `CLI found: ${result.cliFound ? "yes" : "NO — install with: npm i -g @openai/codex"}`,
        `CLI version: ${result.version ?? "unknown"}`,
        `Auth status: ${result.authStatus}`,
        `Default model: ${result.defaultModel ?? "(CLI default)"}`,
        `Fallback model: ${result.fallbackModel ?? "disabled"}`,
        `Supported models: ${modelsSummary}`,
        `Server version: ${result.serverVersion}`,
        `Node version: ${result.nodeVersion}`,
        `Max concurrent: ${result.maxConcurrent}`,
        `Active count: ${result.activeCount}`,
        `Queue depth: ${result.queueDepth}`,
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        _meta: buildMeta({ durationMs }),
      };
    } catch (e) {
      const durationMs = Date.now() - startTime;
      return {
        content: [{ type: "text" as const, text: `Error: ${toErrorMessage(e)}` }],
        isError: true,
        _meta: buildMeta({ durationMs }),
      };
    }
  },
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
