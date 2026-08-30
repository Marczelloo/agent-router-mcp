#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config, log } from "./config.js";
import { AgentRouter } from "./router.js";

const router = new AgentRouter();

const server = new McpServer({
  name: "agent-router",
  version: "0.1.0",
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", error: message }, null, 2) }],
    isError: true,
  };
}

async function guard(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

server.registerTool(
  "codex_get_models",
  {
    title: "List Codex models",
    description:
      "List the Codex models available to this account, with the reasoning-effort levels each one supports. Read live from the Codex model catalogue — never hardcoded. Use it before codex_delegate when you want to match model strength to task difficulty.",
    inputSchema: {
      refresh: z
        .boolean()
        .optional()
        .describe("Bypass the 60s catalogue cache and re-read from Codex."),
    },
  },
  async ({ refresh }) => {
    return guard(async () => {
      if (refresh) await router.listModels(true);
      return router.describeModels();
    });
  },
);

server.registerTool(
  "codex_get_limits",
  {
    title: "Read Codex rate limits",
    description:
      "Read Codex usage limits, normalized by window duration (300 min -> '5h', 10080 min -> 'weekly'), with usedPercent, remainingPercent, resetsAt and rateLimitReached per window, plus a delegation verdict. Check this before delegating anything large.",
    inputSchema: {},
  },
  async () => {
    return guard(async () => {
      const { limits, verdict } = await router.readLimits();
      return {
        quota: {
          state: verdict.state,
          canDelegate: verdict.canDelegate,
          reason: verdict.reason,
        },
        planType: limits.planType,
        windows: limits.windows,
        fiveHour: limits.fiveHour,
        weekly: limits.weekly,
        tightest: limits.tightest,
        credits: limits.credits,
        rateLimitReached: limits.rateLimitReached,
        rateLimitReachedType: limits.rateLimitReachedType,
        resetCreditsAvailable: limits.resetCreditsAvailable,
        fetchedAt: limits.fetchedAt,
      };
    });
  },
);

server.registerTool(
  "codex_delegate",
  {
    title: "Delegate a task to Codex",
    description:
      "Hand a self-contained coding task to Codex as a subagent. Starts a fresh Codex thread, runs the task, and returns the result plus the files it changed. Checks quota first: if Codex has no quota left it returns status 'quota_exhausted' with a handoff so you can finish the work yourself instead of waiting for a reset.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe("The full task instruction for Codex. Be specific and self-contained."),
      workingDirectory: z
        .string()
        .min(1)
        .describe("Absolute path Codex should treat as its working directory."),
      scope: z
        .string()
        .optional()
        .describe("Scope boundary: what Codex may and may not touch."),
      model: z
        .string()
        .optional()
        .describe("Codex model id from codex_get_models. Omit for the account default."),
      reasoningEffort: z
        .string()
        .optional()
        .describe("Reasoning effort supported by the chosen model (see codex_get_models)."),
      isolation: z
        .enum(["none", "worktree"])
        .optional()
        .describe(
          `"worktree" runs Codex in a dedicated git worktree on its own branch, so a bad turn cannot touch the user's working tree. "none" edits in place. Default: ${config.defaultIsolation}.`,
        ),
      branch: z
        .string()
        .optional()
        .describe('Branch name for the worktree. Default: "agent-router/<taskId>".'),
      waitSeconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `How long to block before returning a pollable taskId (default ${config.defaultWaitSeconds}s, max ${config.maxWaitSeconds}s).`,
        ),
    },
  },
  async (args) => guard(() => router.delegate(args)),
);

server.registerTool(
  "codex_continue",
  {
    title: "Continue a Codex task",
    description:
      "Send a follow-up instruction into an existing Codex thread, keeping all of its prior context. Use it to iterate on review feedback instead of re-delegating from scratch.",
    inputSchema: {
      taskId: z.string().min(1).describe("taskId returned by a previous codex_delegate."),
      instruction: z.string().min(1).describe("The follow-up instruction for Codex."),
      model: z.string().optional().describe("Optionally switch model for this turn onward."),
      reasoningEffort: z
        .string()
        .optional()
        .describe("Optionally switch reasoning effort for this turn onward."),
      waitSeconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How long to block before returning a pollable taskId."),
    },
  },
  async (args) => guard(() => router.continueTask(args)),
);

server.registerTool(
  "codex_task_status",
  {
    title: "Check a Codex task",
    description:
      "Read the current state of a delegated task: status, model, reasoning effort, changed files, commands run, plan, diff, worktree, checkpoints, and timestamps. Poll this when codex_delegate returned status 'running'. Omit taskId to list all known tasks.",
    inputSchema: {
      taskId: z
        .string()
        .optional()
        .describe("Task to inspect. Omit to list every task this router knows about."),
    },
  },
  async ({ taskId }) =>
    guard(() => (taskId ? router.status(taskId) : { tasks: router.listTasks() })),
);

server.registerTool(
  "codex_interrupt",
  {
    title: "Interrupt a Codex task",
    description:
      "Stop the turn Codex is currently running for a task. The thread survives, so codex_continue can pick it back up.",
    inputSchema: {
      taskId: z.string().min(1).describe("Task whose in-flight turn should be stopped."),
    },
  },
  async ({ taskId }) => guard(() => router.interrupt(taskId)),
);

server.registerTool(
  "codex_review",
  {
    title: "Have Codex review code",
    description:
      "Ask Codex to review changes and report findings. Use it on YOUR OWN work for a second opinion before you ship, or on a Codex task's output with a different model. Codex reviews read-only and changes nothing. Returns a review task you can poll or extend with codex_continue.",
    inputSchema: {
      workingDirectory: z
        .string()
        .optional()
        .describe("Absolute path to review in. Required unless taskId is given."),
      taskId: z
        .string()
        .optional()
        .describe(
          "Review the work of this Codex task, in its own directory or worktree. Combine with a different model for a cross-model second opinion.",
        ),
      target: z
        .enum(["uncommittedChanges", "baseBranch", "commit", "custom"])
        .optional()
        .describe("What to review. Default: uncommittedChanges."),
      branch: z.string().optional().describe('Base branch, for target "baseBranch".'),
      commit: z.string().optional().describe('Commit sha, for target "commit".'),
      instructions: z
        .string()
        .optional()
        .describe(
          'What to focus on. Required for target "custom"; otherwise added as extra guidance for the reviewer.',
        ),
      model: z.string().optional().describe("Codex model to review with (see codex_get_models)."),
      reasoningEffort: z.string().optional().describe("Reasoning effort for the review."),
      waitSeconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How long to block before returning a pollable taskId."),
    },
  },
  async (args) => guard(() => router.review(args)),
);

server.registerTool(
  "codex_checkpoints",
  {
    title: "List task checkpoints",
    description:
      "List the working-tree snapshots taken around a task's turns. Each checkpoint captures tracked and untracked files without touching the user's index, and can be restored with codex_restore. Requires the working directory to be inside a git repository.",
    inputSchema: {
      taskId: z.string().min(1).describe("Task whose checkpoints should be listed."),
    },
  },
  async ({ taskId }) => guard(() => router.listCheckpoints(taskId)),
);

server.registerTool(
  "codex_restore",
  {
    title: "Restore a checkpoint",
    description:
      "Roll the working tree back to a checkpoint — use it when Codex made things worse. This overwrites files on disk, so confirm with the user before calling it unless they already asked for the rollback. The pre-restore state is always captured as a new checkpoint first, so the operation is itself undoable.",
    inputSchema: {
      taskId: z.string().min(1).describe("Task the checkpoint belongs to."),
      checkpointId: z
        .string()
        .min(1)
        .describe('Checkpoint id from codex_checkpoints, e.g. "cp-1".'),
      removeUntracked: z
        .boolean()
        .optional()
        .describe(
          "Also delete files created after the checkpoint. Default false — they are reported as leftovers instead.",
        ),
    },
  },
  async ({ taskId, checkpointId, removeUntracked }) =>
    guard(() => router.restoreCheckpoint(taskId, checkpointId, { removeUntracked })),
);

server.registerTool(
  "codex_worktree",
  {
    title: "Manage a task's worktree",
    description:
      "Commit or remove the isolated git worktree of a task delegated with isolation \"worktree\". \"commit\" records the work on the task branch and reports the merge command; the router never merges into the user branch itself. \"remove\" tears the worktree down and refuses to discard uncommitted work unless forced.",
    inputSchema: {
      taskId: z.string().min(1).describe("Task whose worktree to act on."),
      action: z
        .enum(["commit", "remove"])
        .describe('"commit" the work onto the task branch, or "remove" the worktree.'),
      message: z.string().optional().describe("Commit message. Defaults to the task description."),
      force: z
        .boolean()
        .optional()
        .describe("For \"remove\": discard uncommitted changes in the worktree."),
    },
  },
  async ({ taskId, action, message, force }) =>
    guard(() => router.worktreeAction(taskId, action, { message, force })),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("agent-router MCP server ready (stdio)");
}

function shutdown(): void {
  router.dispose();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
