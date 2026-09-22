#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config, log } from "./config.js";
import { AgentRouter } from "./router.js";

const router = new AgentRouter();

const server = new McpServer({
  name: "agent-router",
  version: "0.2.0",
});

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = { content: Content[]; isError?: boolean };

function ok(payload: unknown, images: { data: string; mimeType: string }[] = []): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
      ...images.map((img): Content => ({ type: "image", data: img.data, mimeType: img.mimeType })),
    ],
  };
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

interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: any) => Promise<void>;
}

/**
 * While a call blocks on Codex, send MCP progress notifications. Clients that
 * honour them reset their request timeout and can show the user something;
 * without them many clients give up at the SDK's 60 s default. Only sent when
 * the client asked for progress by passing a token.
 */
async function withProgress<T>(extra: ToolExtra, label: string, work: () => Promise<T>): Promise<T> {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return work();
  const started = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: seconds, message: `${label} — ${seconds}s` },
      })
      .catch(() => undefined);
  }, config.progressIntervalSeconds * 1000);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

const modelParam = z
  .string()
  .optional()
  .describe(
    "Codex model id or alias: luna (fast, cheapest), sol (balanced, the default), astra (strongest, heaviest on quota). See codex_get_models.",
  );

const effortParam = z
  .string()
  .optional()
  .describe(
    "Reasoning effort. Capped per model by policy: sol and astra at high, luna at xhigh; higher requests are clamped. Omit for the model's default (medium).",
  );

const waitParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    `How long to block before returning a pollable taskId (default ${config.defaultWaitSeconds}s, max ${config.maxWaitSeconds}s). The task keeps running and finishes on its own either way. Keep it under 60s unless you know your MCP client allows longer calls — many cancel at 60s.`,
  );

const timeoutParam = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    `Hard ceiling for this turn in seconds; past it the router interrupts Codex. Default ${config.turnTimeoutSeconds}s, 0 for none.`,
  );

server.registerTool(
  "codex_get_models",
  {
    title: "List Codex models",
    description:
      "Codex models with their tier, what each is good for, and the reasoning efforts the router allows (after the policy cap). Read live from the Codex catalogue. Use it to match model strength to task difficulty before codex_delegate.",
    inputSchema: {
      refresh: z.boolean().optional().describe("Bypass the 60s catalogue cache and re-read from Codex."),
    },
  },
  async ({ refresh }) =>
    guard(async () => {
      if (refresh) await router.listModels(true);
      return router.describeModels();
    }),
);

server.registerTool(
  "codex_get_limits",
  {
    title: "Read Codex rate limits",
    description:
      "Read Codex usage limits, normalized by window duration (300 min -> '5h', 10080 min -> 'weekly'), with usedPercent, remainingPercent, resetsAt and rateLimitReached per window, plus a delegation verdict. Check this before delegating anything large.",
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      const { limits, verdict } = await router.readLimits();
      return {
        quota: { state: verdict.state, canDelegate: verdict.canDelegate, reason: verdict.reason },
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
    }),
);

server.registerTool(
  "codex_delegate",
  {
    title: "Delegate a task to Codex",
    description:
      "Hand a self-contained coding task to Codex as a subagent. Starts a fresh Codex thread, runs the task, and returns the result plus the files it changed. Checks quota first: if Codex has no quota left it returns status 'quota_exhausted' with a handoff so you can finish the work yourself instead of waiting for a reset. If the task outlives waitSeconds you get status 'running' — wait for it with codex_task_status, never re-delegate.",
    inputSchema: {
      task: z.string().min(1).describe("The full task instruction for Codex. Be specific and self-contained."),
      workingDirectory: z.string().min(1).describe("Absolute path Codex should treat as its working directory."),
      scope: z.string().optional().describe("Scope boundary: what Codex may and may not touch."),
      model: modelParam,
      reasoningEffort: effortParam,
      isolation: z
        .enum(["none", "worktree"])
        .optional()
        .describe(
          `"worktree" runs Codex in a dedicated git worktree on its own branch, so a bad turn cannot touch the user's working tree. "none" edits in place. Default: ${config.defaultIsolation}.`,
        ),
      branch: z.string().optional().describe('Branch name for the worktree. Default: "agent-router/<taskId>".'),
      waitSeconds: waitParam,
      timeoutSeconds: timeoutParam,
    },
  },
  async (args, extra) => guard(() => withProgress(extra, "Codex is working", () => router.delegate(args))),
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
      model: modelParam,
      reasoningEffort: effortParam,
      waitSeconds: waitParam,
      timeoutSeconds: timeoutParam,
    },
  },
  async (args, extra) =>
    guard(() => withProgress(extra, "Codex is working", () => router.continueTask(args))),
);

server.registerTool(
  "codex_task_status",
  {
    title: "Check or wait for a Codex task",
    description:
      "Current state of a task: status, progress (health, running/idle seconds, current step, last message and command), changed files, diff, images, worktree, checkpoints, and any watchdog interventions. Pass waitSeconds to block until the task finishes instead of polling in a loop. Omit taskId to list all tasks.",
    inputSchema: {
      taskId: z.string().optional().describe("Task to inspect. Omit to list every task this router knows about."),
      waitSeconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Block up to this long (max ${config.maxWaitSeconds}s) for a running task to finish.`),
      refresh: z
        .boolean()
        .optional()
        .describe("Re-read the thread from Codex before answering, even if events are still flowing."),
    },
  },
  async ({ taskId, waitSeconds, refresh }, extra) =>
    guard(() =>
      taskId
        ? withProgress(extra, "Waiting for Codex", () => router.status(taskId, { waitSeconds, refresh }))
        : { tasks: router.listTasks() },
    ),
);

server.registerTool(
  "codex_interrupt",
  {
    title: "Interrupt a Codex task",
    description:
      "Stop the turn Codex is running for a task. Guaranteed to take the task out of 'running': if Codex does not confirm within a few seconds, the router checks the thread's real state and, failing that, marks the turn interrupted itself (reported as forced: true). The thread survives, so codex_continue can pick it back up.",
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
      workingDirectory: z.string().optional().describe("Absolute path to review in. Required unless taskId is given."),
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
      model: modelParam,
      reasoningEffort: effortParam,
      waitSeconds: waitParam,
    },
  },
  async (args, extra) => guard(() => withProgress(extra, "Codex is reviewing", () => router.review(args))),
);

server.registerTool(
  "codex_generate_image",
  {
    title: "Generate an image with Codex",
    description:
      "Generate images through Codex's built-in image tool — use it whenever the work needs a real raster image (illustration, icon, texture, mockup, photo-style asset) that you cannot produce yourself. Files are written to disk and a downscaled preview is returned so you can check the result. Pass referenceImages to edit an image or match a style. Runs read-only in Codex; the router writes the files.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe("What to generate. Be concrete: subject, style, composition, colours, any text that must appear."),
      workingDirectory: z
        .string()
        .optional()
        .describe("Directory relative paths resolve against. Defaults to the directory Claude Code was started in."),
      outputPath: z
        .string()
        .optional()
        .describe(
          'Where to save: a file (.png, or .jpg to transcode) or a directory. Default: "<workingDirectory>/generated-images/<prompt-slug>.png". Existing files are not overwritten; a numeric suffix is added instead.',
        ),
      count: z.number().int().min(1).max(4).optional().describe("How many images, 1-4. Default 1."),
      size: z
        .string()
        .optional()
        .describe('Size or aspect ratio hint, e.g. "1024x1024", "16:9 landscape", "portrait". A hint, not a guarantee.'),
      transparentBackground: z.boolean().optional().describe("Ask for a transparent background (PNG)."),
      referenceImages: z
        .array(z.string())
        .optional()
        .describe("Paths to PNG/JPEG images to edit, vary, or take the style from."),
      overwrite: z.boolean().optional().describe("Overwrite an existing file at outputPath instead of suffixing."),
      preview: z
        .enum(["preview", "full", "none"])
        .optional()
        .describe(
          '"preview" (default) returns a downscaled JPEG you can look at; "full" returns the original file (large); "none" returns paths only.',
        ),
      model: modelParam,
      reasoningEffort: effortParam,
      waitSeconds: waitParam,
    },
  },
  async (args, extra) => {
    try {
      const { result, previews } = await withProgress(extra, "Codex is generating", () =>
        router.generateImage(args),
      );
      return ok(result, previews);
    } catch (err) {
      return fail(err);
    }
  },
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
      checkpointId: z.string().min(1).describe('Checkpoint id from codex_checkpoints, e.g. "cp-1".'),
      removeUntracked: z
        .boolean()
        .optional()
        .describe("Also delete files created after the checkpoint. Default false — they are reported as leftovers instead."),
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
      'Commit or remove the isolated git worktree of a task delegated with isolation "worktree". "commit" records the work on the task branch and reports the merge command; the router never merges into the user branch itself. "remove" tears the worktree down and refuses to discard uncommitted work unless forced.',
    inputSchema: {
      taskId: z.string().min(1).describe("Task whose worktree to act on."),
      action: z.enum(["commit", "remove"]).describe('"commit" the work onto the task branch, or "remove" the worktree.'),
      message: z.string().optional().describe("Commit message. Defaults to the task description."),
      force: z.boolean().optional().describe('For "remove": discard uncommitted changes in the worktree.'),
    },
  },
  async ({ taskId, action, message, force }) =>
    guard(() => router.worktreeAction(taskId, action, { message, force })),
);

server.registerTool(
  "codex_server",
  {
    title: "Inspect or restart the Codex app-server",
    description:
      '"status" reports the app-server process (pid, uptime, Codex version, pending requests), every running task with its health, and the watchdog settings. "restart" replaces a wedged app-server: running turns are lost and marked interrupted, but their threads survive and codex_continue resumes them. Restart only when status shows the server unresponsive or tasks stuck despite codex_interrupt.',
    inputSchema: {
      action: z.enum(["status", "restart"]).optional().describe('Default "status".'),
    },
  },
  async ({ action }) => guard(() => (action === "restart" ? router.restartServer() : router.serverStatus())),
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
// A stray rejection must not take the whole server — and every task — down.
process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${String(reason)}`));

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
