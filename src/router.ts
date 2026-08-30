import path from "node:path";
import fs from "node:fs";
import { CodexClient } from "./codex-client.js";
import { config, debugLog } from "./config.js";
import {
  addWorktree,
  changedFilesAgainstBase,
  commitAll,
  diffAgainstBase,
  gitInfo,
  removeWorktree,
  restoreTo,
  snapshotCommit,
} from "./git.js";
import {
  evaluateQuota,
  isQuotaError,
  normalizeLimits,
  type NormalizedLimits,
  type QuotaVerdict,
} from "./limits.js";
import {
  filesFromDiff,
  TaskStore,
  type Checkpoint,
  type Isolation,
  type TaskRecord,
  type TaskStatus,
} from "./tasks.js";
import type {
  ErrorNotification,
  GetAccountRateLimitsResponse,
  ItemCompletedNotification,
  Model,
  ModelListResponse,
  ReviewStartParams,
  ReviewStartResponse,
  ReviewTarget,
  ThreadStartResponse,
  Turn,
  TurnCompletedNotification,
  TurnDiffUpdatedNotification,
  TurnPlanUpdatedNotification,
  TurnStartParams,
  TurnStartResponse,
} from "./protocol.js";

const DIFF_CHAR_LIMIT = 20_000;
const MODEL_CACHE_TTL_MS = 60_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
    reject: (e) => {
      if (d.settled) return;
      d.settled = true;
      reject(e);
    },
  };
  return d;
}

const TIMED_OUT = Symbol("timed-out");

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface DelegateInput {
  task: string;
  workingDirectory: string;
  scope?: string;
  model?: string;
  reasoningEffort?: string;
  waitSeconds?: number;
  isolation?: Isolation;
  branch?: string;
}

export interface ContinueInput {
  taskId: string;
  instruction: string;
  model?: string;
  reasoningEffort?: string;
  waitSeconds?: number;
}

export interface ReviewInput {
  workingDirectory?: string;
  taskId?: string;
  target?: "uncommittedChanges" | "baseBranch" | "commit" | "custom";
  branch?: string;
  commit?: string;
  instructions?: string;
  model?: string;
  reasoningEffort?: string;
  waitSeconds?: number;
}

export interface TaskResult {
  status: TaskStatus | "running";
  taskId: string;
  kind: string;
  threadId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  originalTask: string;
  workingDirectory: string;
  requestedDirectory: string;
  scope: string | null;
  isolation: Isolation;
  worktree: {
    path: string;
    branch: string;
    baseBranch: string | null;
    baseCommit: string | null;
    removed: boolean;
  } | null;
  checkpoints: { id: string; label: string; phase: string; createdAt: string }[];
  reviewOf?: { taskId: string | null; target: string } | null;
  summary: string;
  changedFiles: string[];
  /** Writes Codex attempted but could not apply — never counted as changes. */
  failedFileChanges?: string[];
  commands: string[];
  plan: { step: string; status: string }[];
  diff?: string;
  diffTruncated?: boolean;
  remainingWork?: string;
  error?: { message: string; codexErrorInfo: unknown } | null;
  limits: NormalizedLimits | null;
  quota?: { state: string; reason: string };
  warning?: string;
  timestamps: { createdAt: string; startedAt: string | null; completedAt: string | null };
  nextStep?: string;
  integration?: string;
}

/**
 * Orchestrates the Codex side of a delegation: quota preflight, optional git
 * isolation, thread and turn lifecycle, checkpointing, event accumulation, and
 * the quota handoff back to Claude.
 */
export class AgentRouter {
  private client = new CodexClient();
  private store = new TaskStore();
  private pendingTurns = new Map<string, Deferred<Turn>>();
  private modelCache: { at: number; models: Model[] } | null = null;
  private limitsCache: NormalizedLimits | null = null;

  constructor() {
    this.wireNotifications();
  }

  dispose(): void {
    this.client.dispose();
  }

  // ---------------------------------------------------------------- models

  async listModels(force = false): Promise<Model[]> {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.models;
    }
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await this.client.request<ModelListResponse>("model/list", {
        cursor,
        includeHidden: false,
      });
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    this.modelCache = { at: Date.now(), models };
    return models;
  }

  async describeModels(): Promise<unknown> {
    const models = await this.listModels();
    return {
      defaultModel: models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null,
      models: models.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        isDefault: m.isDefault,
        supersededBy: m.upgrade,
        defaultReasoningEffort: m.defaultReasoningEffort,
        reasoningEfforts: m.supportedReasoningEfforts.map((r) => ({
          effort: r.reasoningEffort,
          description: r.description,
        })),
        inputModalities: m.inputModalities,
        serviceTiers: m.serviceTiers.map((t) => t.id),
      })),
    };
  }

  /** Validate model + effort against the live catalogue; never against a hardcoded list. */
  private async resolveModel(
    model: string | undefined,
    effort: string | undefined,
  ): Promise<{ model: string | null; effort: string | null }> {
    if (!model && !effort) return { model: null, effort: null };
    const models = await this.listModels();
    let chosen: Model | undefined;
    if (model) {
      chosen = models.find((m) => m.id === model || m.model === model);
      if (!chosen) {
        throw new Error(
          `Unknown Codex model "${model}". Available: ${models.map((m) => m.id).join(", ")}`,
        );
      }
    } else {
      chosen = models.find((m) => m.isDefault) ?? models[0];
    }
    if (effort && chosen) {
      const supported = chosen.supportedReasoningEfforts.map((r) => r.reasoningEffort);
      if (!supported.includes(effort)) {
        throw new Error(
          `Model "${chosen.id}" does not support reasoning effort "${effort}". Supported: ${supported.join(", ")}`,
        );
      }
    }
    return { model: model ? (chosen?.id ?? model) : null, effort: effort ?? null };
  }

  // ---------------------------------------------------------------- limits

  async readLimits(): Promise<{ limits: NormalizedLimits; verdict: QuotaVerdict }> {
    const raw = await this.client.request<GetAccountRateLimitsResponse>(
      "account/rateLimits/read",
      {},
    );
    const limits = normalizeLimits(raw);
    this.limitsCache = limits;
    return { limits, verdict: evaluateQuota(limits) };
  }

  /** Last known limits without a round trip — used when building a failure handoff. */
  private cachedLimits(): NormalizedLimits | null {
    return this.limitsCache;
  }

  // ---------------------------------------------------------------- delegate

  async delegate(input: DelegateInput): Promise<TaskResult> {
    const requested = this.resolveCwd(input.workingDirectory);
    const isolation = input.isolation ?? config.defaultIsolation;
    const { model, effort } = await this.resolveModel(input.model, input.reasoningEffort);

    const task = this.store.create({
      originalTask: input.task,
      scope: input.scope ?? null,
      workingDirectory: requested,
      model,
      reasoningEffort: effort,
      isolation,
    });

    // Preflight: never start a thread — or a worktree — we already know is doomed.
    const { limits, verdict } = await this.readLimits();
    if (config.preflight && !verdict.canDelegate) {
      task.status = "quota_exhausted";
      task.quotaAtFailure = limits;
      task.error = { message: verdict.reason, codexErrorInfo: "usageLimitExceeded" };
      task.completedAt = new Date().toISOString();
      this.store.touch(task);
      return this.buildHandoff(task, limits, verdict, "preflight");
    }

    if (isolation === "worktree") this.setupWorktree(task, requested, input.branch);

    const started = await this.client.request<ThreadStartResponse>("thread/start", {
      model: model ?? undefined,
      cwd: task.workingDirectory,
      approvalPolicy: config.approvalPolicy,
      sandbox: config.sandbox,
      developerInstructions: this.buildDeveloperInstructions(task, input.scope),
    });

    task.threadId = started.thread.id;
    task.model = started.model ?? model;
    task.reasoningEffort = effort ?? started.reasoningEffort ?? null;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.store.touch(task);

    return this.runTurn(task, this.composePrompt(input.task, input.scope), {
      model,
      effort,
      waitSeconds: input.waitSeconds,
      verdict,
      limits,
    });
  }

  async continueTask(input: ContinueInput): Promise<TaskResult> {
    const task = this.store.get(input.taskId);
    if (!task) throw new Error(`Unknown taskId "${input.taskId}".`);
    if (!task.threadId) {
      throw new Error(
        `Task "${input.taskId}" has no Codex thread (it never started — status ${task.status}). Delegate a new task instead.`,
      );
    }
    if (task.status === "running") {
      throw new Error(
        `Task "${input.taskId}" is still running. Poll codex_task_status or call codex_interrupt first.`,
      );
    }
    if (task.worktree?.removed) {
      throw new Error(
        `Task "${input.taskId}" ran in a worktree that has since been removed (${task.worktree.path}). Delegate a new task instead.`,
      );
    }

    const { model, effort } = await this.resolveModel(input.model, input.reasoningEffort);

    const { limits, verdict } = await this.readLimits();
    if (config.preflight && !verdict.canDelegate) {
      task.status = "quota_exhausted";
      task.quotaAtFailure = limits;
      task.currentInstruction = input.instruction;
      task.error = { message: verdict.reason, codexErrorInfo: "usageLimitExceeded" };
      this.store.touch(task);
      return this.buildHandoff(task, limits, verdict, "preflight");
    }

    await this.client.request("thread/resume", {
      threadId: task.threadId,
      model: model ?? undefined,
      cwd: task.workingDirectory,
      approvalPolicy: config.approvalPolicy,
      sandbox: config.sandbox,
    });

    task.currentInstruction = input.instruction;
    if (model) task.model = model;
    if (effort) task.reasoningEffort = effort;
    task.status = "running";
    task.completedAt = null;
    task.error = null;
    this.store.touch(task);

    return this.runTurn(task, input.instruction, {
      model,
      effort,
      waitSeconds: input.waitSeconds,
      verdict,
      limits,
    });
  }

  // ---------------------------------------------------------------- review

  /**
   * Ask Codex to review changes — Claude's own work, or the output of a previous
   * Codex task (optionally with a different model, for a genuine second opinion).
   *
   * Uses the native `review/start` with inline delivery, so the review runs on
   * the thread we just created and its events arrive through the normal turn
   * lifecycle.
   */
  async review(input: ReviewInput): Promise<TaskResult> {
    const reviewed = input.taskId ? this.store.get(input.taskId) : null;
    if (input.taskId && !reviewed) throw new Error(`Unknown taskId "${input.taskId}".`);
    if (reviewed?.status === "running") {
      throw new Error(
        `Task "${input.taskId}" is still running. Wait for it to finish before reviewing it.`,
      );
    }

    const cwdInput = input.workingDirectory ?? reviewed?.workingDirectory;
    if (!cwdInput) {
      throw new Error("codex_review needs either workingDirectory or taskId.");
    }
    const cwd = this.resolveCwd(cwdInput);

    const target = this.buildReviewTarget(input, reviewed);
    const { model, effort } = await this.resolveModel(input.model, input.reasoningEffort);

    const task = this.store.create({
      kind: "review",
      originalTask: `Review ${target.description} in ${cwd}`,
      scope: input.instructions ?? null,
      workingDirectory: cwd,
      model,
      reasoningEffort: effort,
      reviewOf: { taskId: reviewed?.taskId ?? null, target: target.description },
    });

    const { limits, verdict } = await this.readLimits();
    if (config.preflight && !verdict.canDelegate) {
      task.status = "quota_exhausted";
      task.quotaAtFailure = limits;
      task.error = { message: verdict.reason, codexErrorInfo: "usageLimitExceeded" };
      task.completedAt = new Date().toISOString();
      this.store.touch(task);
      return this.buildHandoff(task, limits, verdict, "preflight");
    }

    const started = await this.client.request<ThreadStartResponse>("thread/start", {
      model: model ?? undefined,
      cwd,
      approvalPolicy: config.approvalPolicy,
      // A reviewer has no business editing the tree it is reviewing.
      sandbox: "read-only",
      developerInstructions: this.buildReviewerInstructions(input, reviewed),
    });

    task.threadId = started.thread.id;
    task.model = started.model ?? model;
    task.reasoningEffort = effort ?? started.reasoningEffort ?? null;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.store.touch(task);

    return this.runTurn(
      task,
      task.originalTask,
      { model, effort, waitSeconds: input.waitSeconds, verdict, limits },
      async (waitMs) => {
        const params: ReviewStartParams = {
          threadId: task.threadId!,
          target: target.target,
          delivery: "inline",
        };
        const res = await this.client.request<ReviewStartResponse>(
          "review/start",
          params,
          waitMs + 30_000,
        );
        return res.turn;
      },
    );
  }

  private buildReviewTarget(
    input: ReviewInput,
    reviewed: TaskRecord | null | undefined,
  ): { target: ReviewTarget; description: string } {
    const kind = input.target ?? "uncommittedChanges";
    switch (kind) {
      case "baseBranch": {
        if (!input.branch) throw new Error('target "baseBranch" needs a branch.');
        return {
          target: { type: "baseBranch", branch: input.branch },
          description: `changes against base branch ${input.branch}`,
        };
      }
      case "commit": {
        if (!input.commit) throw new Error('target "commit" needs a commit sha.');
        return {
          target: { type: "commit", sha: input.commit, title: null },
          description: `commit ${input.commit}`,
        };
      }
      case "custom": {
        if (!input.instructions) throw new Error('target "custom" needs instructions.');
        return {
          target: { type: "custom", instructions: input.instructions },
          description: "a custom review request",
        };
      }
      default:
        return {
          target: { type: "uncommittedChanges" },
          description: reviewed
            ? `the uncommitted changes from task ${reviewed.taskId}`
            : "the uncommitted changes",
        };
    }
  }

  private buildReviewerInstructions(
    input: ReviewInput,
    reviewed: TaskRecord | null | undefined,
  ): string {
    const lines = [
      "You are acting as a code reviewer for a Claude Code tech lead.",
      "Review only — do not edit files.",
      "Report concrete, actionable findings: correctness bugs first, then missed requirements, then maintainability.",
      "For each finding give the file, the line if you can, why it is wrong, and what to do instead.",
      "Say plainly when the change looks correct; do not invent findings to fill space.",
    ];
    if (reviewed) {
      lines.push(
        `These changes were produced by another agent for this task: ${reviewed.originalTask}`,
      );
      if (reviewed.scope) lines.push(`It was told to stay within this scope: ${reviewed.scope}`);
      lines.push("Flag anything that went outside that scope.");
    }
    if (input.instructions && input.target !== "custom") {
      lines.push(`Extra guidance from the tech lead: ${input.instructions}`);
    }
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- control

  async interrupt(taskId: string): Promise<TaskResult> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown taskId "${taskId}".`);
    if (!task.threadId || !task.activeTurnId) {
      return this.buildResult(task, task.status, this.cachedLimits());
    }
    try {
      await this.client.request("turn/interrupt", {
        threadId: task.threadId,
        turnId: task.activeTurnId,
      });
    } catch (err) {
      debugLog("turn/interrupt failed:", (err as Error).message);
    }
    const pending = this.pendingTurns.get(task.threadId);
    task.status = "interrupted";
    task.activeTurnId = null;
    task.completedAt = new Date().toISOString();
    this.store.touch(task);
    pending?.resolve({
      id: "",
      items: [],
      status: "interrupted",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });
    return this.buildResult(task, "interrupted", this.cachedLimits());
  }

  status(taskId: string): TaskResult {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown taskId "${taskId}".`);
    return this.buildResult(task, task.status, this.cachedLimits(), { includeDiff: true });
  }

  listTasks(): unknown {
    return this.store.list().map((t) => ({
      taskId: t.taskId,
      kind: t.kind,
      status: t.status,
      threadId: t.threadId,
      model: t.model,
      reasoningEffort: t.reasoningEffort,
      isolation: t.isolation,
      worktreeBranch: t.worktree?.branch ?? null,
      workingDirectory: t.workingDirectory,
      originalTask: t.originalTask.slice(0, 200),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      changedFiles: t.changedFiles.length,
      checkpoints: t.checkpoints.length,
    }));
  }

  // ---------------------------------------------------------------- checkpoints

  listCheckpoints(taskId: string): unknown {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown taskId "${taskId}".`);
    return {
      taskId: task.taskId,
      workingDirectory: task.workingDirectory,
      isolation: task.isolation,
      checkpointing: !config.checkpoints
        ? "off"
        : task.checkpoints.length > 0
          ? "on"
          : "on (nothing captured — the working directory is not a git repository)",
      checkpoints: task.checkpoints.map((c) => ({
        id: c.id,
        label: c.label,
        phase: c.phase,
        turnIndex: c.turnIndex,
        commit: c.commit,
        createdAt: c.createdAt,
      })),
    };
  }

  /**
   * Roll the working tree back to a checkpoint.
   *
   * Always snapshots the current state first, so a restore is itself undoable —
   * the returned `safetyCheckpoint` is a valid target for another restore.
   */
  restoreCheckpoint(
    taskId: string,
    checkpointId: string,
    opts: { removeUntracked?: boolean } = {},
  ): unknown {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown taskId "${taskId}".`);
    if (task.status === "running") {
      throw new Error(
        `Task "${taskId}" is still running. Call codex_interrupt first — restoring under a live turn would race Codex.`,
      );
    }
    const checkpoint = task.checkpoints.find((c) => c.id === checkpointId);
    if (!checkpoint) {
      const available = task.checkpoints.map((c) => c.id).join(", ") || "none";
      throw new Error(
        `Unknown checkpoint "${checkpointId}" for task ${taskId}. Available: ${available}`,
      );
    }

    const safety = this.captureCheckpoint(
      task,
      "pre-restore",
      `state before restoring ${checkpoint.id}`,
    );
    const result = restoreTo(checkpoint.repoRoot, checkpoint.commit, {
      removeExtra: opts.removeUntracked === true,
    });

    return {
      status: "restored",
      taskId: task.taskId,
      restoredTo: { id: checkpoint.id, label: checkpoint.label, commit: checkpoint.commit },
      repoRoot: checkpoint.repoRoot,
      filesInCheckpoint: result.filesInSnapshot,
      removedFiles: result.removed,
      /** Files that exist now but were not in the checkpoint. */
      leftoverFiles: result.leftover,
      safetyCheckpoint: safety ? { id: safety.id, label: safety.label } : null,
      note: safety
        ? `The pre-restore state was captured as checkpoint "${safety.id}"; restoring that undoes this operation.`
        : "The pre-restore state could not be captured (not a git repository).",
      ...(result.leftover.length > 0 && opts.removeUntracked !== true
        ? {
            hint: `${result.leftover.length} file(s) created after the checkpoint were left in place. Pass removeUntracked: true to delete them.`,
          }
        : {}),
    };
  }

  private captureCheckpoint(
    task: TaskRecord,
    phase: Checkpoint["phase"],
    label: string,
  ): Checkpoint | null {
    if (!config.checkpoints || task.kind !== "delegation") return null;
    const info = gitInfo(task.workingDirectory);
    if (!info) return null;
    const commit = snapshotCommit(task.workingDirectory, `agent-router checkpoint: ${label}`);
    if (!commit) return null;
    const checkpoint: Checkpoint = {
      id: `cp-${task.checkpoints.length + 1}`,
      label,
      commit,
      repoRoot: info.repoRoot,
      phase,
      turnIndex: task.turns.length,
      createdAt: new Date().toISOString(),
    };
    this.store.addCheckpoint(task, checkpoint);
    return checkpoint;
  }

  // ---------------------------------------------------------------- worktrees

  private setupWorktree(task: TaskRecord, requestedCwd: string, branch?: string): void {
    const info = gitInfo(requestedCwd);
    if (!info) {
      throw new Error(
        `isolation "worktree" needs a git repository, but ${requestedCwd} is not inside one. Use isolation "none".`,
      );
    }
    const branchName = branch ?? `agent-router/${task.taskId}`;
    const worktreePath = path.join(
      config.worktreeRoot,
      `${path.basename(info.repoRoot)}-${task.taskId}`,
    );
    const created = addWorktree({ repoRoot: info.repoRoot, worktreePath, branch: branchName });

    // Keep Codex in the same relative subdirectory it was pointed at.
    const rel = path.relative(info.repoRoot, requestedCwd);
    const effectiveCwd = rel && !rel.startsWith("..") ? path.join(created.path, rel) : created.path;

    task.worktree = { ...created, removed: false };
    task.workingDirectory = fs.existsSync(effectiveCwd) ? effectiveCwd : created.path;
    this.store.touch(task);
  }

  worktreeAction(
    taskId: string,
    action: "commit" | "remove",
    opts: { message?: string; force?: boolean } = {},
  ): unknown {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown taskId "${taskId}".`);
    const wt = task.worktree;
    if (!wt) {
      throw new Error(
        `Task "${taskId}" has no worktree (isolation was "${task.isolation}"). Delegate with isolation "worktree" to get one.`,
      );
    }
    if (wt.removed) throw new Error(`The worktree for task "${taskId}" has already been removed.`);
    if (task.status === "running") {
      throw new Error(
        `Task "${taskId}" is still running. Interrupt it before touching its worktree.`,
      );
    }

    if (action === "commit") {
      const message = opts.message ?? `agent-router: ${task.originalTask.slice(0, 72)}`;
      const sha = commitAll(wt.path, message);
      if (!sha) {
        return {
          status: "nothing_to_commit",
          taskId: task.taskId,
          branch: wt.branch,
          note: "Codex left no changes in the worktree.",
        };
      }
      return {
        status: "committed",
        taskId: task.taskId,
        branch: wt.branch,
        commit: sha,
        integration: `From ${wt.repoRoot}, run: git merge ${wt.branch}`,
        note: "The commit lives only on the isolated branch. Merging is left to you deliberately — the router never writes to the user's branch.",
      };
    }

    const info = gitInfo(wt.path);
    if (info?.isDirty && opts.force !== true) {
      throw new Error(
        `The worktree for task "${taskId}" has uncommitted changes. Commit them first (codex_worktree action "commit"), or pass force: true to discard them.`,
      );
    }
    removeWorktree(wt.repoRoot, wt.path, { force: opts.force === true });
    wt.removed = true;
    this.store.touch(task);
    return {
      status: "removed",
      taskId: task.taskId,
      path: wt.path,
      branch: wt.branch,
      note: `The worktree is gone. Branch ${wt.branch} still exists in ${wt.repoRoot}; delete it with: git branch -D ${wt.branch}`,
    };
  }

  // ---------------------------------------------------------------- internals

  private resolveCwd(workingDirectory: string): string {
    const resolved = path.resolve(workingDirectory);
    if (!fs.existsSync(resolved)) {
      throw new Error(`workingDirectory does not exist: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`workingDirectory is not a directory: ${resolved}`);
    }
    return resolved;
  }

  private buildDeveloperInstructions(task: TaskRecord, scope?: string): string {
    const lines = [
      "You are running as a delegated subagent under a Claude Code tech lead.",
      "Work autonomously: no human is available to answer approval prompts.",
      "Stay strictly inside the scope you were given; do not refactor unrelated code.",
      "Finish your final message with a short report: what you changed, which files, and anything left undone.",
    ];
    if (scope) lines.push(`Scope boundary from the tech lead: ${scope}`);
    if (task.worktree) {
      lines.push(
        `You are working in an isolated git worktree on branch ${task.worktree.branch}. Do not switch branches, commit, or run git operations that reach other worktrees.`,
      );
    }
    return lines.join("\n");
  }

  private composePrompt(task: string, scope?: string): string {
    if (!scope) return task;
    return `${task}\n\n---\nScope: ${scope}`;
  }

  private async runTurn(
    task: TaskRecord,
    instruction: string,
    opts: {
      model: string | null;
      effort: string | null;
      waitSeconds?: number;
      verdict: QuotaVerdict;
      limits: NormalizedLimits;
    },
    start?: (waitMs: number) => Promise<Turn>,
  ): Promise<TaskResult> {
    const threadId = task.threadId!;
    const waitMs =
      Math.min(opts.waitSeconds ?? config.defaultWaitSeconds, config.maxWaitSeconds) * 1000;

    this.captureCheckpoint(task, "pre-turn", `before turn ${task.turns.length + 1}`);

    const completion = deferred<Turn>();
    this.pendingTurns.set(threadId, completion);

    task.turns.push({
      turnId: null,
      instruction,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "running",
    });

    const starter =
      start ??
      (async (budget: number) => {
        const params: TurnStartParams = {
          threadId,
          input: [{ type: "text", text: instruction, text_elements: [] }],
          cwd: task.workingDirectory,
          approvalPolicy: config.approvalPolicy,
          model: opts.model ?? undefined,
          effort: opts.effort ?? undefined,
        };
        const res = await this.client.request<TurnStartResponse>(
          "turn/start",
          params,
          budget + 30_000,
        );
        return res.turn;
      });

    // The start request may return as soon as the turn is queued or only once it
    // is done, so we listen for turn/completed and treat the response as a bonus.
    starter(waitMs)
      .then((turn) => {
        // `review/start` returns a placeholder turn whose id differs from the
        // turn Codex actually runs, and the `turn/started` notification may beat
        // this callback. The notification is authoritative; only fill the gap.
        if (!task.activeTurnId) {
          task.activeTurnId = turn.id;
          const last = task.turns[task.turns.length - 1];
          if (last) last.turnId = turn.id;
        }
        this.store.touch(task);
        if (turn.status !== "inProgress") completion.resolve(turn);
      })
      .catch((err: Error) => completion.reject(err));

    let turn: Turn | typeof TIMED_OUT;
    try {
      turn = await withTimeout(completion.promise, waitMs);
    } catch (err) {
      this.pendingTurns.delete(threadId);
      return this.finishWithError(task, err as Error);
    }

    if (turn === TIMED_OUT) {
      // Codex is still working; hand back a pollable handle instead of blocking.
      return this.buildResult(task, "running", opts.limits, {
        nextStep: `Codex is still working after ${waitMs / 1000}s. Poll codex_task_status("${task.taskId}") or stop it with codex_interrupt("${task.taskId}").`,
        quota: opts.verdict,
      });
    }

    this.pendingTurns.delete(threadId);
    return this.finishTurn(task, turn, opts.verdict);
  }

  private async finishTurn(
    task: TaskRecord,
    turn: Turn,
    verdict: QuotaVerdict,
  ): Promise<TaskResult> {
    this.absorbTurnItems(task, turn);
    task.activeTurnId = null;
    task.completedAt = new Date().toISOString();
    const last = task.turns[task.turns.length - 1];
    if (last) last.endedAt = task.completedAt;

    if (turn.status === "failed" && isQuotaError(turn.error)) {
      const { limits, verdict: fresh } = await this.readLimitsSafely();
      task.status = "quota_exhausted";
      task.error = turn.error
        ? { message: turn.error.message, codexErrorInfo: turn.error.codexErrorInfo }
        : null;
      task.quotaAtFailure = limits;
      if (last) last.status = "quota_exhausted";
      this.captureCheckpoint(task, "post-turn", `after turn ${task.turns.length} (quota exhausted)`);
      this.store.touch(task);
      return this.buildHandoff(task, limits, fresh, "mid-task");
    }

    if (turn.status === "failed") {
      task.status = "failed";
      task.error = turn.error
        ? { message: turn.error.message, codexErrorInfo: turn.error.codexErrorInfo }
        : { message: "Codex turn failed without an error payload.", codexErrorInfo: null };
      if (last) last.status = "failed";
      this.captureCheckpoint(task, "post-turn", `after turn ${task.turns.length} (failed)`);
      this.store.touch(task);
      return this.buildResult(task, "failed", this.cachedLimits(), {
        quota: verdict,
        includeDiff: true,
        nextStep:
          "Codex could not finish. Review the error and either retry with codex_continue or take the task over yourself.",
      });
    }

    task.status = turn.status === "interrupted" ? "interrupted" : "completed";
    if (last) last.status = task.status;
    this.captureCheckpoint(task, "post-turn", `after turn ${task.turns.length}`);
    this.store.touch(task);
    return this.buildResult(task, task.status, this.cachedLimits(), {
      quota: verdict,
      includeDiff: true,
      nextStep: this.nextStepFor(task),
    });
  }

  /**
   * Codex can finish a turn cleanly while every write it attempted was rejected
   * — a broken sandbox does exactly that. Saying "completed" without flagging it
   * would send the tech lead off to review files that were never written.
   */
  private writeFailureWarning(task: TaskRecord): { warning: string } | null {
    if (task.failedFileChanges.length === 0) return null;
    const blocked = task.failedFileChanges.map((c) => c.path).join(", ");
    if (task.changedFiles.length === 0) {
      return {
        warning: `Codex could not write any files: every patch was ${task.failedFileChanges[0].reason} (${blocked}). Nothing changed on disk. This usually means the Codex sandbox is misconfigured — check "codex sandbox" and consider AGENT_ROUTER_SANDBOX. Do not review these files; they were not created.`,
      };
    }
    return {
      warning: `Codex applied some changes but ${task.failedFileChanges.length} patch(es) were rejected (${blocked}). Those files were not written.`,
    };
  }

  private nextStepFor(task: TaskRecord): string {
    if (task.status === "completed" && task.changedFiles.length === 0 && task.failedFileChanges.length > 0) {
      return "Codex reported success but wrote nothing — its patches were rejected. Do not review the listed files. Fix the Codex sandbox, or take the task over yourself.";
    }
    if (task.status !== "completed") {
      return "The turn was interrupted; resume with codex_continue if the work is still wanted.";
    }
    if (task.kind === "review") {
      return "Read the findings and decide which to act on. Codex reviewed read-only; nothing was changed.";
    }
    if (task.worktree) {
      return `Review the changes in the worktree, then commit them with codex_worktree({ taskId: "${task.taskId}", action: "commit" }) and merge branch ${task.worktree.branch} yourself.`;
    }
    return "Review the changed files before accepting the work.";
  }

  private async finishWithError(task: TaskRecord, err: Error): Promise<TaskResult> {
    task.activeTurnId = null;
    task.completedAt = new Date().toISOString();
    const last = task.turns[task.turns.length - 1];

    if (isQuotaError({ message: err.message })) {
      const { limits, verdict } = await this.readLimitsSafely();
      task.status = "quota_exhausted";
      task.error = { message: err.message, codexErrorInfo: "usageLimitExceeded" };
      task.quotaAtFailure = limits;
      if (last) last.status = "quota_exhausted";
      this.store.touch(task);
      return this.buildHandoff(task, limits, verdict, "mid-task");
    }

    task.status = "failed";
    task.error = { message: err.message, codexErrorInfo: null };
    if (last) last.status = "failed";
    this.store.touch(task);
    return this.buildResult(task, "failed", this.cachedLimits(), {
      nextStep: "Codex failed at the transport level. Take the task over yourself.",
    });
  }

  private async readLimitsSafely(): Promise<{
    limits: NormalizedLimits | null;
    verdict: QuotaVerdict;
  }> {
    try {
      return await this.readLimits();
    } catch (err) {
      debugLog("could not refresh limits:", (err as Error).message);
      const cached = this.cachedLimits();
      return {
        limits: cached,
        verdict: cached
          ? evaluateQuota(cached)
          : {
              state: "exhausted",
              canDelegate: false,
              reason: "Codex reported a usage limit and the limits endpoint is unreachable.",
              blockingWindow: null,
            },
      };
    }
  }

  private absorbTurnItems(task: TaskRecord, turn: Turn): void {
    for (const item of turn.items ?? []) this.absorbItem(task, item);
  }

  private absorbItem(task: TaskRecord, item: any): void {
    switch (item?.type) {
      case "agentMessage":
        if (item.text && !task.agentMessages.includes(item.text)) task.agentMessages.push(item.text);
        break;
      case "reasoning": {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n").trim();
        if (text && !task.reasoningSummaries.includes(text)) task.reasoningSummaries.push(text);
        break;
      }
      case "plan":
        if (item.text) task.plan = [{ step: item.text, status: "pending" }];
        break;
      case "commandExecution":
        if (item.command && !task.commands.includes(item.command)) task.commands.push(item.command);
        break;
      case "fileChange": {
        // `status` is inProgress | completed | failed | declined. Recording a
        // failed patch as a change would tell the tech lead a file exists when
        // it does not, so the two are kept strictly apart.
        const applied = item.status === "completed" || item.status === undefined;
        for (const change of item.changes ?? []) {
          const entry = {
            path: change.path,
            kind: change.kind?.type ?? "update",
            movedTo: change.kind?.move_path ?? null,
          };
          if (applied) {
            this.store.recordFileChange(task, entry);
          } else if (item.status !== "inProgress") {
            this.store.recordFailedFileChange(task, entry, String(item.status));
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private wireNotifications(): void {
    const client = this.client;

    client.on("notification:turn/started", (params: { threadId: string; turn: Turn }) => {
      const task = this.store.byThreadId(params.threadId);
      if (!task) return;
      task.activeTurnId = params.turn.id;
      const last = task.turns[task.turns.length - 1];
      if (last && last.status === "running") last.turnId = params.turn.id;
      task.status = "running";
      this.store.touch(task);
    });

    client.on("notification:item/completed", (params: ItemCompletedNotification) => {
      const task = this.store.byThreadId(params.threadId);
      if (!task) return;
      this.absorbItem(task, params.item);
      this.store.touch(task);
    });

    client.on("notification:turn/diff/updated", (params: TurnDiffUpdatedNotification) => {
      const task = this.store.byThreadId(params.threadId);
      if (!task) return;
      task.diff = params.diff;
      // Backstop for file changes Codex made without a fileChange item.
      for (const file of filesFromDiff(params.diff)) {
        this.store.recordFileFromDiff(task, file);
      }
      this.store.touch(task);
    });

    client.on("notification:turn/plan/updated", (params: TurnPlanUpdatedNotification) => {
      const task = this.store.byThreadId(params.threadId);
      if (!task) return;
      task.plan = params.plan ?? [];
      this.store.touch(task);
    });

    client.on(
      "notification:thread/tokenUsage/updated",
      (params: { threadId: string; tokenUsage: any }) => {
        const task = this.store.byThreadId(params.threadId);
        if (!task) return;
        task.tokenUsage = {
          total: params.tokenUsage?.total?.totalTokens ?? null,
          contextWindow: params.tokenUsage?.modelContextWindow ?? null,
        };
      },
    );

    client.on("notification:turn/completed", (params: TurnCompletedNotification) => {
      const task = this.store.byThreadId(params.threadId);
      if (task) this.absorbTurnItems(task, params.turn);
      this.pendingTurns.get(params.threadId)?.resolve(params.turn);
    });

    client.on("notification:error", (params: ErrorNotification) => {
      if (params.willRetry) {
        debugLog("codex retrying after error:", params.error?.message);
        return;
      }
      const pending = this.pendingTurns.get(params.threadId);
      if (!pending) return;
      // Resolve as a synthetic failed turn: a `turn/completed` may never arrive
      // for fatal errors, and we must not leave the caller hanging.
      pending.resolve({
        id: params.turnId,
        items: [],
        status: "failed",
        error: params.error,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      });
    });

    client.on("notification:account/rateLimits/updated", (params: { rateLimits: any }) => {
      try {
        this.limitsCache = normalizeLimits({
          rateLimits: params.rateLimits,
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
        });
      } catch (err) {
        debugLog("could not merge rate limit update:", (err as Error).message);
      }
    });

    client.on("exit", () => {
      for (const [threadId, pending] of this.pendingTurns) {
        pending.reject(new Error("codex app-server exited before the turn completed"));
        this.pendingTurns.delete(threadId);
      }
      for (const task of this.store.list()) {
        if (task.status === "running") {
          task.status = "interrupted";
          task.activeTurnId = null;
        }
      }
    });
  }

  // ---------------------------------------------------------------- results

  private summarize(task: TaskRecord): string {
    if (task.agentMessages.length > 0) return task.agentMessages[task.agentMessages.length - 1];
    if (task.reasoningSummaries.length > 0) {
      return task.reasoningSummaries[task.reasoningSummaries.length - 1];
    }
    return "Codex produced no assistant message.";
  }

  private remainingWork(task: TaskRecord): string {
    const open = task.plan.filter((s) => s.status !== "completed");
    if (open.length > 0) {
      return `Unfinished plan steps reported by Codex:\n${open
        .map((s) => `- [${s.status}] ${s.step}`)
        .join("\n")}`;
    }
    if (task.changedFiles.length === 0) {
      return `Codex made no file changes. The task is effectively untouched: ${task.originalTask}`;
    }
    return `Codex stopped partway through. It touched ${task.changedFiles.length} file(s); verify them and complete the remainder of: ${task.originalTask}`;
  }

  /**
   * Files changed across the whole worktree, not just the last turn. Falls back
   * to the per-turn accumulation when the task is not isolated.
   */
  private changedFilesFor(task: TaskRecord): string[] {
    if (task.worktree && !task.worktree.removed && task.worktree.baseCommit) {
      const rows = changedFilesAgainstBase(task.worktree.path, task.worktree.baseCommit);
      if (rows.length > 0) {
        const kinds: Record<string, string> = { A: "add", D: "delete", M: "update", R: "rename" };
        return rows.map((row) => {
          const [statusCode, file] = row.split("\t");
          return `${file} (${kinds[statusCode?.[0] ?? "M"] ?? "update"})`;
        });
      }
    }
    return task.changedFiles.map((c) =>
      c.movedTo ? `${c.path} -> ${c.movedTo} (${c.kind})` : `${c.path} (${c.kind})`,
    );
  }

  private diffFor(task: TaskRecord): string | null {
    if (task.worktree && !task.worktree.removed && task.worktree.baseCommit) {
      const cumulative = diffAgainstBase(task.worktree.path, task.worktree.baseCommit);
      if (cumulative) return cumulative;
    }
    return task.diff;
  }

  private buildResult(
    task: TaskRecord,
    status: TaskStatus | "running",
    limits: NormalizedLimits | null,
    opts: { nextStep?: string; quota?: QuotaVerdict; includeDiff?: boolean } = {},
  ): TaskResult {
    const diff = opts.includeDiff ? this.diffFor(task) : undefined;
    const truncated = Boolean(diff && diff.length > DIFF_CHAR_LIMIT);
    return {
      status,
      taskId: task.taskId,
      kind: task.kind,
      threadId: task.threadId,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      originalTask: task.originalTask,
      workingDirectory: task.workingDirectory,
      requestedDirectory: task.requestedDirectory,
      scope: task.scope,
      isolation: task.isolation,
      worktree: task.worktree
        ? {
            path: task.worktree.path,
            branch: task.worktree.branch,
            baseBranch: task.worktree.baseBranch,
            baseCommit: task.worktree.baseCommit,
            removed: task.worktree.removed,
          }
        : null,
      checkpoints: task.checkpoints.map((c) => ({
        id: c.id,
        label: c.label,
        phase: c.phase,
        createdAt: c.createdAt,
      })),
      ...(task.reviewOf ? { reviewOf: task.reviewOf } : {}),
      summary: this.summarize(task),
      changedFiles: this.changedFilesFor(task),
      ...(task.failedFileChanges.length > 0
        ? {
            failedFileChanges: task.failedFileChanges.map((c) => `${c.path} (${c.reason})`),
          }
        : {}),
      commands: task.commands.slice(-25),
      plan: task.plan,
      ...(diff
        ? { diff: truncated ? `${diff.slice(0, DIFF_CHAR_LIMIT)}\n… [truncated]` : diff }
        : {}),
      ...(truncated ? { diffTruncated: true } : {}),
      error: task.error,
      limits,
      ...(opts.quota ? { quota: { state: opts.quota.state, reason: opts.quota.reason } } : {}),
      ...(this.writeFailureWarning(task) ?? (opts.quota && opts.quota.state === "low"
        ? { warning: opts.quota.reason }
        : {})),
      timestamps: {
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      },
      ...(opts.nextStep ? { nextStep: opts.nextStep } : {}),
      ...(task.worktree && !task.worktree.removed
        ? {
            integration: `Isolated on branch ${task.worktree.branch} in ${task.worktree.path}. Nothing has touched ${task.worktree.repoRoot}.`,
          }
        : {}),
    };
  }

  /**
   * The quota handoff. Claude is expected to finish the work itself from here —
   * the router deliberately does not retry or wait for a reset.
   */
  private buildHandoff(
    task: TaskRecord,
    limits: NormalizedLimits | null,
    verdict: QuotaVerdict,
    stage: "preflight" | "mid-task",
  ): TaskResult {
    const reset = verdict.blockingWindow?.resetsAt ?? null;
    const base = this.buildResult(task, "quota_exhausted", limits, { includeDiff: true });
    return {
      ...base,
      summary:
        stage === "preflight"
          ? `Codex was not started: ${verdict.reason}`
          : `Codex ran out of quota mid-task. ${this.summarize(task)}`,
      remainingWork:
        stage === "preflight"
          ? `Nothing was delegated. Complete the task yourself: ${task.originalTask}`
          : this.remainingWork(task),
      quota: { state: verdict.state, reason: verdict.reason },
      nextStep: `Do NOT wait for the quota to reset${reset ? ` (${reset})` : ""} and do NOT retry Codex. Take the task over and finish it yourself.`,
    };
  }
}
