import path from "node:path";
import fs from "node:fs";
import { CodexClient } from "./codex-client.js";
import { config, debugLog, log } from "./config.js";
import {
  addWorktree,
  changedFilesAgainstBase,
  changedFilesBetween,
  commitAll,
  diffAgainstBase,
  diffBetween,
  gitInfo,
  removeWorktree,
  restoreTo,
  snapshotCommit,
} from "./git.js";
import {
  inspectImage,
  makePreview,
  measureTransparency,
  planOutputPaths,
  writeGeneratedImage,
  type PreviewMode,
} from "./images.js";
import {
  evaluateQuota,
  isQuotaError,
  normalizeLimits,
  type NormalizedLimits,
  type QuotaVerdict,
} from "./limits.js";
import { describeCatalogue, resolveModel as resolvePolicyModel } from "./models.js";
import {
  filesFromDiff,
  TaskStore,
  type Checkpoint,
  type Intervention,
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
  ThreadReadResponse,
  ThreadStartResponse,
  ThreadStatus,
  ThreadStatusChangedNotification,
  Turn,
  TurnCompletedNotification,
  TurnDiffUpdatedNotification,
  TurnPlanUpdatedNotification,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from "./protocol.js";

const DIFF_CHAR_LIMIT = 20_000;
const MODEL_CACHE_TTL_MS = 60_000;
/** Below this much silence a running turn is plainly alive; no need to re-read it. */
const QUIET_BEFORE_RECONCILE_MS = 20_000;

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

function syntheticTurn(status: Turn["status"], id: string | null, error: Turn["error"] = null): Turn {
  return { id: id ?? "", items: [], status, error, startedAt: null, completedAt: null, durationMs: null };
}

/**
 * The live half of a turn. `finished` settles once the turn's outcome has been
 * processed, which happens exactly once whether or not anyone is still waiting.
 */
interface ActiveTurn {
  taskId: string;
  completion: Deferred<Turn>;
  finished: Promise<TaskResult>;
  /** Every id this turn has been known by — review/start hands out a placeholder. */
  turnIds: Set<string>;
  verdict: QuotaVerdict;
}

export interface DelegateInput {
  task: string;
  workingDirectory: string;
  scope?: string;
  model?: string;
  reasoningEffort?: string;
  waitSeconds?: number;
  timeoutSeconds?: number;
  isolation?: Isolation;
  branch?: string;
}

export interface ContinueInput {
  taskId: string;
  instruction: string;
  model?: string;
  reasoningEffort?: string;
  waitSeconds?: number;
  timeoutSeconds?: number;
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

export interface ImageInput {
  prompt: string;
  workingDirectory?: string;
  outputPath?: string;
  count?: number;
  size?: string;
  transparentBackground?: boolean;
  referenceImages?: string[];
  overwrite?: boolean;
  preview?: PreviewMode;
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
  /**
   * Where changedFiles came from: git snapshots of the worktree or working tree
   * (complete, including shell writes), or only what Codex reported.
   */
  changeSource?: "worktree" | "working-tree" | "codex-reported";
  /** Writes Codex attempted but could not apply — never counted as changes. */
  failedFileChanges?: string[];
  images?: {
    path: string;
    width: number | null;
    height: number | null;
    bytes: number;
    mimeType: string;
    revisedPrompt: string | null;
    transparentPercent: number;
  }[];
  failedImages?: { reason: string; resetsAt: string | null }[];
  commands: string[];
  plan: { step: string; status: string }[];
  diff?: string;
  diffTruncated?: boolean;
  remainingWork?: string;
  error?: { message: string; codexErrorInfo: unknown } | null;
  limits: NormalizedLimits | null;
  quota?: { state: string; reason: string };
  warning?: string;
  notes?: string[];
  progress?: {
    health: "active" | "quiet" | "stalled" | "blocked";
    runningSeconds: number | null;
    idleSeconds: number | null;
    lastActivityAt: string | null;
    deadlineAt: string | null;
    blockedOn: string | null;
    currentStep: string | null;
    lastMessage: string | null;
    lastCommand: string | null;
  };
  interventions?: Intervention[];
  forced?: boolean;
  timestamps: { createdAt: string; startedAt: string | null; completedAt: string | null };
  nextStep?: string;
  integration?: string;
}

export interface ImageResult {
  result: TaskResult;
  previews: { mimeType: string; data: string }[];
}

/**
 * Orchestrates the Codex side of a delegation: model policy, quota preflight,
 * optional git isolation, the thread and turn lifecycle, liveness supervision,
 * checkpointing, image generation, and the quota handoff back to Claude.
 */
export class AgentRouter {
  private client = new CodexClient();
  private store = new TaskStore();
  /** Keyed by threadId. */
  private active = new Map<string, ActiveTurn>();
  /**
   * Turn ids already settled, per thread. After a forced stop Codex may still
   * deliver the old turn's completion; without this it could be mistaken for
   * the next turn started on the same thread.
   */
  private retired = new Map<string, Set<string>>();
  private modelCache: { at: number; models: Model[] } | null = null;
  private limitsCache: NormalizedLimits | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor() {
    this.wireNotifications();
    this.startWatchdog();
  }

  dispose(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.store.flush();
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
    return describeCatalogue(await this.listModels());
  }

  /** Model and effort for a new thread, after aliases, defaults and policy caps. */
  private async pickModel(
    model: string | undefined,
    effort: string | undefined,
    fallback: { model?: string; effort?: string } = {},
  ): Promise<{ model: string | null; effort: string | null; notes: string[] }> {
    return resolvePolicyModel(await this.listModels(), model, effort, fallback);
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

  private cachedVerdict(): QuotaVerdict {
    return this.limitsCache
      ? evaluateQuota(this.limitsCache)
      : { state: "ok", canDelegate: true, reason: "Quota not re-checked.", blockingWindow: null };
  }

  // ---------------------------------------------------------------- delegate

  async delegate(input: DelegateInput): Promise<TaskResult> {
    const requested = this.resolveCwd(input.workingDirectory);
    const isolation = input.isolation ?? config.defaultIsolation;
    const { model, effort, notes } = await this.pickModel(input.model, input.reasoningEffort);

    const task = this.store.create({
      originalTask: input.task,
      scope: input.scope ?? null,
      workingDirectory: requested,
      model,
      reasoningEffort: effort,
      isolation,
    });
    task.notes.push(...notes);

    // Preflight: never start a thread — or a worktree — we already know is doomed.
    const { limits, verdict } = await this.readLimits();
    if (config.preflight && !verdict.canDelegate) {
      return this.refuseForQuota(task, limits, verdict);
    }

    if (isolation === "worktree") this.setupWorktree(task, requested, input.branch);

    const started = await this.client.request<ThreadStartResponse>("thread/start", {
      model: model ?? undefined,
      cwd: task.workingDirectory,
      approvalPolicy: config.approvalPolicy,
      sandbox: config.sandbox,
      developerInstructions: this.buildDeveloperInstructions(task, input.scope),
    });
    this.markStarted(task, started, model, effort);

    return this.runTurn(task, this.composePrompt(input.task, input.scope), {
      model,
      effort,
      waitSeconds: input.waitSeconds,
      timeoutSeconds: input.timeoutSeconds,
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
      // A lost completion must not wedge the task: check with Codex first.
      await this.reconcile(task, "codex_continue on a running task");
      if (task.status === "running") {
        throw new Error(
          `Task "${input.taskId}" is still running in Codex. Wait with codex_task_status({ taskId, waitSeconds }) or stop it with codex_interrupt.`,
        );
      }
    }
    if (task.worktree?.removed) {
      throw new Error(
        `Task "${input.taskId}" ran in a worktree that has since been removed (${task.worktree.path}). Delegate a new task instead.`,
      );
    }

    let model: string | null = null;
    let effort: string | null = null;
    if (input.model || input.reasoningEffort) {
      // Changing only the effort still has to respect the current model's cap.
      const picked = await this.pickModel(input.model ?? task.model ?? undefined, input.reasoningEffort);
      model = input.model ? picked.model : null;
      effort = picked.effort;
      task.notes.push(...picked.notes);
    }

    const { limits, verdict } = await this.readLimits();
    if (config.preflight && !verdict.canDelegate) {
      task.currentInstruction = input.instruction;
      return this.refuseForQuota(task, limits, verdict);
    }

    await this.client.request("thread/resume", {
      threadId: task.threadId,
      model: model ?? undefined,
      cwd: task.workingDirectory,
      approvalPolicy: config.approvalPolicy,
      sandbox: task.kind === "review" || task.kind === "image" ? "read-only" : config.sandbox,
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
      timeoutSeconds: input.timeoutSeconds,
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
      await this.reconcile(reviewed, "codex_review of a running task");
      if (reviewed.status === "running") {
        throw new Error(
          `Task "${input.taskId}" is still running. Wait for it to finish before reviewing it.`,
        );
      }
    }

    const cwdInput = input.workingDirectory ?? reviewed?.workingDirectory;
    if (!cwdInput) {
      throw new Error("codex_review needs either workingDirectory or taskId.");
    }
    const cwd = this.resolveCwd(cwdInput);

    const target = this.buildReviewTarget(input, reviewed);
    const { model, effort, notes } = await this.pickModel(input.model, input.reasoningEffort);

    const task = this.store.create({
      kind: "review",
      originalTask: `Review ${target.description} in ${cwd}`,
      scope: input.instructions ?? null,
      workingDirectory: cwd,
      model,
      reasoningEffort: effort,
      reviewOf: { taskId: reviewed?.taskId ?? null, target: target.description },
    });
    task.notes.push(...notes);

    const { limits, verdict } = await this.readLimits();
    if (config.preflight && !verdict.canDelegate) {
      return this.refuseForQuota(task, limits, verdict);
    }

    const started = await this.client.request<ThreadStartResponse>("thread/start", {
      model: model ?? undefined,
      cwd,
      approvalPolicy: config.approvalPolicy,
      // A reviewer has no business editing the tree it is reviewing.
      sandbox: "read-only",
      developerInstructions: this.buildReviewerInstructions(input, reviewed),
    });
    this.markStarted(task, started, model, effort);

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

  // ---------------------------------------------------------------- images

  /**
   * Generate images through Codex's built-in image tool.
   *
   * The thread runs read-only: generation happens server-side, and the router
   * writes the files itself from the returned data. That keeps image work
   * independent of the local sandbox, which on some Windows installs cannot
   * write at all.
   */
  async generateImage(input: ImageInput): Promise<ImageResult> {
    const cwd = this.resolveCwd(input.workingDirectory ?? process.cwd());
    const count = Math.max(1, Math.min(4, Math.floor(input.count ?? 1)));

    const references = (input.referenceImages ?? []).map((ref) => {
      const abs = path.resolve(cwd, ref);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new Error(`Reference image not found: ${abs}`);
      }
      const kind = inspectImage(fs.readFileSync(abs)).mimeType;
      if (kind === "application/octet-stream") {
        throw new Error(`Reference image is not a PNG or JPEG: ${abs}`);
      }
      return abs;
    });

    const outputPaths = planOutputPaths({
      outputPath: input.outputPath,
      workingDirectory: cwd,
      prompt: input.prompt,
      count,
      overwrite: input.overwrite === true,
    });

    const { model, effort, notes } = await this.pickModel(input.model, input.reasoningEffort, {
      model: config.imageModel,
      effort: config.imageEffort,
    });

    const task = this.store.create({
      kind: "image",
      originalTask: input.prompt,
      scope: null,
      workingDirectory: cwd,
      model,
      reasoningEffort: effort,
    });
    task.notes.push(...notes);
    task.imageRequest = {
      outputPaths,
      count,
      transparentBackground: input.transparentBackground === true,
      overwrite: input.overwrite === true,
    };

    const { limits, verdict } = await this.readLimits();
    if (config.preflight && !verdict.canDelegate) {
      return { result: this.refuseForQuota(task, limits, verdict), previews: [] };
    }

    const started = await this.client.request<ThreadStartResponse>("thread/start", {
      model: model ?? undefined,
      cwd,
      approvalPolicy: config.approvalPolicy,
      sandbox: "read-only",
      developerInstructions: [
        "You are an image-generation subagent working for a Claude Code tech lead.",
        `Use your image generation tool to create exactly ${count} image${count === 1 ? "" : "s"} for the request.`,
        "Do not run shell commands and do not write or edit files — the router saves the images itself.",
        "Do not embed images, markdown image links or data URIs in your reply.",
        "If reference images are attached, use them as the request describes (edit, variation or style reference).",
        "When you are done, reply with one short sentence describing what you generated.",
      ].join("\n"),
    });
    this.markStarted(task, started, model, effort);

    const requirements = [
      count > 1 ? `- Generate ${count} separate images.` : null,
      input.size ? `- Size / aspect ratio: ${input.size}.` : null,
      input.transparentBackground ? "- Use a transparent background." : null,
      references.length > 0 ? `- ${references.length} reference image(s) are attached.` : null,
    ].filter(Boolean);
    const text = requirements.length ? `${input.prompt}\n\nRequirements:\n${requirements.join("\n")}` : input.prompt;

    const inputItems: UserInput[] = [
      { type: "text", text, text_elements: [] },
      ...references.map((p): UserInput => ({ type: "localImage", path: p })),
    ];

    const result = await this.runTurn(task, text, {
      model,
      effort,
      waitSeconds: input.waitSeconds,
      verdict,
      limits,
      input: inputItems,
    });
    return { result, previews: this.previewsFor(task, input.preview ?? "preview") };
  }

  private previewsFor(task: TaskRecord, mode: PreviewMode): { mimeType: string; data: string }[] {
    if (mode === "none" || task.status === "running") return [];
    const previews: { mimeType: string; data: string }[] = [];
    for (const image of task.images) {
      try {
        const buf = fs.readFileSync(image.path);
        if (mode === "full") {
          previews.push({ mimeType: image.mimeType, data: buf.toString("base64") });
        } else {
          const preview = makePreview(buf, config.imagePreviewMaxEdge);
          if (preview) previews.push(preview);
        }
      } catch (err) {
        debugLog("could not build preview:", (err as Error).message);
      }
    }
    return previews;
  }

  /** Save a finished image item to its planned path, once. */
  private absorbImage(task: TaskRecord, item: any): void {
    if (task.images.some((i) => i.id === item.id) || task.failedImages.some((i) => i.id === item.id)) {
      return;
    }
    const status = String(item.status ?? "").toLowerCase();
    if (item.failure || ["failed", "error", "cancelled", "canceled"].includes(status)) {
      const failure = item.failure ?? {};
      task.failedImages.push({
        id: item.id,
        reason: failure.type ?? status ?? "failed",
        resetsAt: typeof failure.resetsAt === "number" ? new Date(failure.resetsAt * 1000).toISOString() : null,
      });
      return;
    }
    if (status !== "completed") return;

    const planned = task.imageRequest?.outputPaths ?? [];
    let destination = planned[task.images.length];
    if (!destination) {
      // Codex made more images than asked for; keep them rather than drop them.
      const first = planned[0] ?? path.join(task.workingDirectory, "generated-images", "image.png");
      const ext = path.extname(first);
      destination = path.join(
        path.dirname(first),
        `${path.basename(first, ext)}-extra-${task.images.length + 1}${ext}`,
      );
    }
    try {
      const { buf, path: written } = writeGeneratedImage(
        destination,
        { base64: item.result, savedPath: item.savedPath },
        { overwrite: task.imageRequest?.overwrite === true },
      );
      const info = inspectImage(buf);
      task.images.push({
        id: item.id,
        path: written,
        bytes: buf.length,
        width: info.width,
        height: info.height,
        mimeType: info.mimeType,
        revisedPrompt: item.revisedPrompt ?? null,
        transparentPercent: measureTransparency(buf).transparentPercent,
      });
    } catch (err) {
      task.failedImages.push({ id: item.id, reason: (err as Error).message, resetsAt: null });
    }
  }

  // ---------------------------------------------------------------- control

  async interrupt(taskId: string): Promise<TaskResult> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown taskId "${taskId}".`);
    if (task.status !== "running") {
      return this.buildResult(task, task.status, this.cachedLimits(), {
        nextStep: `Task is not running (status ${task.status}); nothing to interrupt.`,
      });
    }
    return this.stopTurn(task, "Interrupted by the caller.", false);
  }

  /**
   * Stop a running turn and guarantee the task leaves "running".
   *
   * Ask Codex first; if it does not confirm within the grace period, check the
   * thread's real state; only then force the local record. A forced stop is
   * recorded so the caller knows Codex may still be finishing in the background.
   */
  private async stopTurn(task: TaskRecord, reason: string, automatic: boolean): Promise<TaskResult> {
    // Bind to the turn that is live right now. Every await below can let it
    // finish and a new turn start on the same thread; nothing here may touch
    // that new turn — it would stop work the caller never asked to stop.
    const target = task.threadId ? this.active.get(task.threadId) : undefined;
    if (!task.threadId || !target) {
      if (task.status === "running") {
        this.store.intervene(task, "forced", `${reason} No live turn record was found, so the task was marked interrupted.`);
        this.settle(task, syntheticTurn("interrupted", task.activeTurnId));
      }
      return { ...this.buildResult(task, task.status, this.cachedLimits()), forced: true };
    }
    const threadId = task.threadId;
    if (automatic) this.store.intervene(task, "auto-interrupted", reason);

    const turnId = await this.currentTurnId(task, target);
    if (turnId && !target.completion.settled) {
      try {
        await this.client.request("turn/interrupt", { threadId, turnId }, 15_000);
      } catch (err) {
        debugLog("turn/interrupt failed:", (err as Error).message);
      }
    }

    const confirmed = await withTimeout(target.finished, config.interruptGraceSeconds * 1000);
    if (confirmed !== TIMED_OUT) return { ...confirmed, forced: false };

    if ((await this.reconcile(task, reason, target)) === "finished") {
      return { ...(await target.finished), forced: false };
    }

    this.store.intervene(
      task,
      "forced",
      `${reason} Codex did not confirm the interrupt within ${config.interruptGraceSeconds}s, so the router marked the turn interrupted itself. Codex may still be finishing in the background.`,
    );
    this.settle(task, syntheticTurn("interrupted", turnId), target);
    return { ...(await target.finished), forced: true };
  }

  /** The id Codex knows `target` by, looked up on the thread if no event carried it. */
  private async currentTurnId(task: TaskRecord, target: ActiveTurn): Promise<string | null> {
    const threadId = task.threadId!;
    // `turn/started` is authoritative; review/start's reply id is a placeholder.
    const authoritative = this.active.get(threadId) === target ? task.activeTurnId : null;
    const known = authoritative ?? [...target.turnIds].pop();
    if (known) return known;
    try {
      const { thread } = await this.client.request<ThreadReadResponse>(
        "thread/read",
        { threadId, includeTurns: true },
        15_000,
      );
      const retired = this.retired.get(threadId);
      const found = [...(thread.turns ?? [])]
        .reverse()
        .find((t) => t.status === "inProgress" && !retired?.has(t.id));
      if (!found || target.completion.settled || this.active.get(threadId) !== target) return null;
      // Record it, so settling this turn also retires the id and a late
      // completion for it cannot be mistaken for a later turn.
      target.turnIds.add(found.id);
      return found.id;
    } catch {
      return null;
    }
  }

  /**
   * Ask Codex what really happened to a turn we believe is running, and settle
   * it if Codex says it ended. This is the cure for a lost `turn/completed`:
   * without it, one dropped notification leaves a task "running" forever.
   *
   * Bound to the turn that was live when the read began: if that turn settled
   * while the read was in flight, the snapshot is stale and a newer turn on the
   * same thread must not be judged by it.
   */
  private async reconcile(
    task: TaskRecord,
    reason: string,
    target?: ActiveTurn,
  ): Promise<"finished" | "running" | "unknown"> {
    if (task.status !== "running" || !task.threadId) return "finished";
    const threadId = task.threadId;
    const bound = target ?? this.active.get(threadId);
    if (bound && (bound.completion.settled || this.active.get(threadId) !== bound)) return "finished";

    let thread: ThreadReadResponse["thread"];
    try {
      ({ thread } = await this.client.request<ThreadReadResponse>(
        "thread/read",
        { threadId, includeTurns: true },
        15_000,
      ));
    } catch (err) {
      debugLog("reconcile: thread/read failed:", (err as Error).message);
      return "unknown";
    }
    if (bound ? bound.completion.settled || this.active.get(threadId) !== bound : task.status !== "running") {
      return "finished"; // settled while we were asking
    }

    this.applyThreadStatus(task, thread.status);
    const turns = thread.turns ?? [];
    const retired = this.retired.get(threadId);
    const turn =
      turns.find((t) => bound?.turnIds.has(t.id)) ??
      // Nothing identifies the live turn yet: the newest turn is the best guess,
      // but never one already settled — that would be an earlier turn's outcome.
      [...turns].reverse().find((t) => !retired?.has(t.id));

    if (turn && turn.status !== "inProgress") {
      this.store.intervene(task, "reconciled", `${reason}: Codex reports the turn ${turn.status}.`);
      this.settle(task, turn, bound);
      return "finished";
    }
    const status = thread.status?.type;
    if (status === "systemError") {
      this.store.intervene(task, "reconciled", `${reason}: Codex reports a system error on the thread.`);
      this.settle(
        task,
        syntheticTurn("failed", turn?.id ?? null, {
          message: "Codex reported a system error on this thread.",
          codexErrorInfo: "other",
          additionalDetails: null,
        }),
        bound,
      );
      return "finished";
    }
    if (status === "notLoaded") {
      // A thread the app-server does not have loaded cannot be running a turn.
      this.store.intervene(task, "reconciled", `${reason}: the thread is not loaded in the app-server.`);
      this.settle(task, syntheticTurn("interrupted", turn?.id ?? null), bound);
      return "finished";
    }
    return "running";
  }

  /** Feed a turn outcome into the one place that processes it. */
  private settle(task: TaskRecord, turn: Turn, target?: ActiveTurn): void {
    const active = target ?? (task.threadId ? this.active.get(task.threadId) : undefined);
    if (active) {
      active.completion.resolve(turn);
    } else if (task.status === "running") {
      void this.finishTurn(task, turn, this.cachedVerdict()).catch((err) =>
        log(`could not finish ${task.taskId}: ${(err as Error).message}`),
      );
    }
  }

  private applyThreadStatus(task: TaskRecord, status: ThreadStatus | undefined): void {
    if (!status) return;
    task.threadStatus = status.type;
    const flags = status.type === "active" ? status.activeFlags ?? [] : [];
    const blocked = flags.find((f) => f === "waitingOnApproval" || f === "waitingOnUserInput") ?? null;
    if (blocked && task.blockedOn !== blocked) {
      task.blockedOn = blocked;
      task.blockedSince = new Date().toISOString();
    } else if (!blocked) {
      task.blockedOn = null;
      task.blockedSince = null;
    }
  }

  async status(
    taskId: string,
    opts: { waitSeconds?: number; refresh?: boolean } = {},
  ): Promise<TaskResult> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown taskId "${taskId}".`);

    if (task.status === "running") {
      const quietMs = Date.now() - Date.parse(task.lastActivityAt ?? task.startedAt ?? task.createdAt);
      if (opts.refresh === true || (opts.refresh !== false && quietMs > QUIET_BEFORE_RECONCILE_MS)) {
        await this.reconcile(task, "status check");
      }
    }

    if (task.status === "running" && opts.waitSeconds && task.threadId) {
      const active = this.active.get(task.threadId);
      if (active) {
        const outcome = await withTimeout(active.finished, this.waitBudget(opts.waitSeconds));
        if (outcome !== TIMED_OUT) return outcome;
      }
    }

    return this.buildResult(task, task.status, this.cachedLimits(), {
      includeDiff: true,
      nextStep: task.status === "running" ? this.runningNextStep(task) : this.nextStepFor(task),
    });
  }

  listTasks(): unknown {
    return this.store.list().map((t) => ({
      taskId: t.taskId,
      kind: t.kind,
      status: t.status,
      ...(t.status === "running" ? { health: this.healthOf(t) } : {}),
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
      images: t.images.length,
      checkpoints: t.checkpoints.length,
    }));
  }

  // ---------------------------------------------------------------- server

  serverStatus(): unknown {
    const info = this.client.info();
    const version = info.userAgent?.match(/\/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    return {
      appServer: { ...info, codexVersion: version },
      runningTasks: this.store.running().map((t) => ({
        taskId: t.taskId,
        kind: t.kind,
        health: this.healthOf(t),
        runningSeconds: this.secondsSince(t.turns[t.turns.length - 1]?.startedAt ?? t.startedAt),
        idleSeconds: this.secondsSince(t.lastActivityAt),
        blockedOn: t.blockedOn,
      })),
      watchdog: {
        intervalSeconds: config.watchdogIntervalSeconds,
        stallSeconds: config.stallSeconds,
        turnTimeoutSeconds: config.turnTimeoutSeconds,
        blockedTimeoutSeconds: config.blockedTimeoutSeconds,
        interruptGraceSeconds: config.interruptGraceSeconds,
      },
      defaults: {
        model: config.defaultModel,
        imageModel: config.imageModel,
        imageEffort: config.imageEffort,
        sandbox: config.sandbox,
        isolation: config.defaultIsolation,
      },
    };
  }

  /**
   * Replace the app-server process. Running turns are lost and reported as
   * interrupted; their threads stay on disk and codex_continue resumes them.
   */
  async restartServer(): Promise<unknown> {
    const interrupted = this.store.running().map((t) => t.taskId);
    await this.client.restart();
    return {
      status: "restarted",
      interruptedTasks: interrupted,
      note:
        interrupted.length > 0
          ? "These tasks were marked interrupted. Their threads survive; resume them with codex_continue."
          : "No turns were running.",
      appServer: this.client.info(),
    };
  }

  // ---------------------------------------------------------------- watchdog

  private startWatchdog(): void {
    const ms = Math.max(0.2, config.watchdogIntervalSeconds) * 1000;
    this.watchdog = setInterval(() => void this.sweep(), ms);
    this.watchdog.unref?.();
  }

  /**
   * Keep every running task honest. Hard deadlines and unanswerable blocks are
   * interrupted; mere silence only triggers a re-read of the thread, because a
   * long command can be quiet and still be doing real work.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const task of this.store.running()) {
        const now = Date.now();
        if (task.turnDeadlineAt && now > Date.parse(task.turnDeadlineAt)) {
          await this.stopTurn(task, "The turn exceeded its time limit.", true);
          continue;
        }
        if (
          task.blockedOn &&
          task.blockedSince &&
          now - Date.parse(task.blockedSince) > config.blockedTimeoutSeconds * 1000
        ) {
          await this.stopTurn(
            task,
            `Codex was waiting on ${task.blockedOn === "waitingOnApproval" ? "an approval" : "user input"} that a headless router cannot give.`,
            true,
          );
          continue;
        }
        const quietMs = now - Date.parse(task.lastActivityAt ?? task.startedAt ?? task.createdAt);
        if (quietMs > config.stallSeconds * 1000) {
          const outcome = await this.reconcile(task, `No events from Codex for ${Math.round(quietMs / 1000)}s`);
          const last = task.interventions[task.interventions.length - 1];
          const alreadyFlagged =
            last?.action === "stalled" && Date.parse(last.at) > Date.parse(task.lastActivityAt ?? "0");
          if (outcome !== "finished" && task.status === "running" && !alreadyFlagged) {
            this.store.intervene(
              task,
              "stalled",
              `No events from Codex for ${Math.round(quietMs / 1000)}s, but the thread still reports the turn in progress. It may be running a silent command; interrupt it if that is unlikely.`,
            );
          }
        }
      }
    } catch (err) {
      log(`watchdog sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  private healthOf(task: TaskRecord): "active" | "quiet" | "stalled" | "blocked" {
    if (task.blockedOn) return "blocked";
    const quiet = this.secondsSince(task.lastActivityAt ?? task.startedAt) ?? 0;
    if (quiet > config.stallSeconds) return "stalled";
    if (quiet > 30) return "quiet";
    return "active";
  }

  private secondsSince(iso: string | null | undefined): number | null {
    return iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)) : null;
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
          : task.kind !== "delegation"
            ? `off for ${task.kind} tasks (they do not write to the working tree)`
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
  async restoreCheckpoint(
    taskId: string,
    checkpointId: string,
    opts: { removeUntracked?: boolean } = {},
  ): Promise<unknown> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown taskId "${taskId}".`);
    if (task.status === "running") {
      await this.reconcile(task, "codex_restore on a running task");
      if (task.status === "running") {
        throw new Error(
          `Task "${taskId}" is still running. Call codex_interrupt first — restoring under a live turn would race Codex.`,
        );
      }
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

  async worktreeAction(
    taskId: string,
    action: "commit" | "remove",
    opts: { message?: string; force?: boolean } = {},
  ): Promise<unknown> {
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
      await this.reconcile(task, "codex_worktree on a running task");
      if (task.status === "running") {
        throw new Error(
          `Task "${taskId}" is still running. Interrupt it before touching its worktree.`,
        );
      }
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

  private markStarted(
    task: TaskRecord,
    started: ThreadStartResponse,
    model: string | null,
    effort: string | null,
  ): void {
    task.threadId = started.thread.id;
    task.model = started.model ?? model;
    task.reasoningEffort = effort ?? started.reasoningEffort ?? null;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.store.touch(task);
  }

  private refuseForQuota(
    task: TaskRecord,
    limits: NormalizedLimits,
    verdict: QuotaVerdict,
  ): TaskResult {
    task.status = "quota_exhausted";
    task.quotaAtFailure = limits;
    task.error = { message: verdict.reason, codexErrorInfo: "usageLimitExceeded" };
    task.completedAt = new Date().toISOString();
    this.store.touch(task);
    return this.buildHandoff(task, limits, verdict, "preflight");
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

  private waitBudget(waitSeconds?: number): number {
    return Math.min(waitSeconds ?? config.defaultWaitSeconds, config.maxWaitSeconds) * 1000;
  }

  private async runTurn(
    task: TaskRecord,
    instruction: string,
    opts: {
      model: string | null;
      effort: string | null;
      waitSeconds?: number;
      timeoutSeconds?: number;
      verdict: QuotaVerdict;
      limits: NormalizedLimits;
      input?: UserInput[];
    },
    start?: (waitMs: number) => Promise<Turn>,
  ): Promise<TaskResult> {
    const threadId = task.threadId!;
    const waitMs = this.waitBudget(opts.waitSeconds);

    this.captureCheckpoint(task, "pre-turn", `before turn ${task.turns.length + 1}`);

    const now = Date.now();
    const timeout = opts.timeoutSeconds ?? config.turnTimeoutSeconds;
    task.lastActivityAt = new Date(now).toISOString();
    task.turnDeadlineAt = timeout > 0 ? new Date(now + timeout * 1000).toISOString() : null;
    task.threadStatus = "active";
    task.blockedOn = null;
    task.blockedSince = null;
    task.activeTurnId = null;
    // Image outcomes are judged on what this turn produced, not on images a
    // previous turn of the same task already saved.
    task.imageBaseline = { images: task.images.length, failed: task.failedImages.length };
    task.turns.push({
      turnId: null,
      instruction,
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      status: "running",
    });

    // The outcome is processed exactly once, by whoever settles the turn — never
    // only by the caller that happened to be waiting. Otherwise a turn that
    // outlives waitSeconds finishes in Codex and stays "running" here forever.
    const completion = deferred<Turn>();
    const active: ActiveTurn = {
      taskId: task.taskId,
      completion,
      finished: Promise.resolve(null as unknown as TaskResult),
      turnIds: new Set(),
      verdict: opts.verdict,
    };
    // Retire every id this turn was known by at the moment it settles, before
    // finishing clears the task's turn state. A late event carrying one of them
    // is then recognisably stale instead of landing on the next turn.
    const retireIds = (turn?: Turn) => {
      if (turn?.id) active.turnIds.add(turn.id);
      if (task.activeTurnId) active.turnIds.add(task.activeTurnId);
      for (const id of active.turnIds) this.retire(threadId, id);
    };
    active.finished = completion.promise
      .then(
        (turn) => {
          retireIds(turn);
          return this.finishTurn(task, turn, opts.verdict);
        },
        (err: Error) => {
          retireIds();
          return this.finishWithError(task, err);
        },
      )
      .catch((err: Error) => this.finishCrashed(task, err))
      .finally(() => {
        if (this.active.get(threadId)?.completion === completion) this.active.delete(threadId);
      });
    const finished = active.finished;
    this.active.set(threadId, active);
    this.store.touch(task);

    const starter =
      start ??
      (async (budget: number) => {
        const params: TurnStartParams = {
          threadId,
          input: opts.input ?? [{ type: "text", text: instruction, text_elements: [] }],
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
        if (this.active.get(threadId) !== active || completion.settled) {
          // This turn was already settled (forced stop, reconcile) and the task
          // may have moved on to a newer turn; the late reply must not touch it.
          if (turn.id) this.retire(threadId, turn.id);
          return;
        }
        if (turn.id) active.turnIds.add(turn.id);
        // `review/start` returns a placeholder turn whose id differs from the
        // turn Codex actually runs, and the `turn/started` notification may beat
        // this callback. The notification is authoritative; only fill the gap.
        if (!task.activeTurnId && turn.id) {
          task.activeTurnId = turn.id;
          const last = task.turns[task.turns.length - 1];
          if (last && !last.turnId) last.turnId = turn.id;
        }
        this.store.touch(task);
        if (turn.status !== "inProgress") completion.resolve(turn);
      })
      .catch((err: Error) => completion.reject(err));

    const outcome = await withTimeout(finished, waitMs);
    if (outcome !== TIMED_OUT) return outcome;

    // Codex is still working; hand back a pollable handle instead of blocking.
    return this.buildResult(task, "running", opts.limits, {
      nextStep: this.runningNextStep(task),
      quota: opts.verdict,
    });
  }

  private runningNextStep(task: TaskRecord): string {
    return `Codex is still working. Wait for it with codex_task_status({ taskId: "${task.taskId}", waitSeconds: 50 }) — do not re-delegate — or stop it with codex_interrupt("${task.taskId}").`;
  }

  private async finishTurn(
    task: TaskRecord,
    turn: Turn,
    verdict: QuotaVerdict,
  ): Promise<TaskResult> {
    this.absorbTurnItems(task, turn);
    task.activeTurnId = null;
    task.turnDeadlineAt = null;
    task.blockedOn = null;
    task.blockedSince = null;
    task.completedAt = new Date().toISOString();
    const last = task.turns[task.turns.length - 1];
    if (last) last.endedAt = task.completedAt;

    if (task.kind === "image") return this.finishImageTurn(task, turn, verdict);

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
   * An image task succeeds only if an image reached disk. Its quota failures are
   * reported differently from code tasks: Claude cannot generate images itself,
   * so "finish it yourself" is not an option to hand back.
   */
  private async finishImageTurn(task: TaskRecord, turn: Turn, verdict: QuotaVerdict): Promise<TaskResult> {
    const last = task.turns[task.turns.length - 1];
    // Judge this turn by what it produced: after a codex_continue the task
    // still holds the earlier turn's images, which say nothing about this one.
    const baseline = task.imageBaseline ?? { images: 0, failed: 0 };
    const fresh = task.images.slice(baseline.images);
    const freshFailures = task.failedImages.slice(baseline.failed);
    const quotaFailure = freshFailures.find((f) => /usageLimitExceeded|rateLimit/i.test(f.reason));
    const turnQuota = turn.status === "failed" && isQuotaError(turn.error);

    if (fresh.length === 0 && (quotaFailure || turnQuota)) {
      const { limits } = await this.readLimitsSafely();
      task.status = "quota_exhausted";
      task.quotaAtFailure = limits;
      task.error = {
        message: turn.error?.message ?? "Image generation quota exhausted.",
        codexErrorInfo: "usageLimitExceeded",
      };
      if (last) last.status = "quota_exhausted";
      this.store.touch(task);
      const reset = quotaFailure?.resetsAt;
      return {
        ...this.buildResult(task, "quota_exhausted", limits),
        summary: `Image generation quota is exhausted${reset ? ` until ${reset}` : ""}. No image was produced.`,
        remainingWork: `The image was not generated: ${task.originalTask}`,
        nextStep: `You cannot generate images yourself. Tell the user the image quota is exhausted${reset ? ` (resets ${reset})` : ""}; if the image is not essential, offer an alternative such as an SVG or a placeholder. Do not retry in a loop.`,
      };
    }

    if (fresh.length === 0) {
      task.status = turn.status === "interrupted" ? "interrupted" : "failed";
      task.error = turn.error
        ? { message: turn.error.message, codexErrorInfo: turn.error.codexErrorInfo }
        : {
            message:
              freshFailures[0]?.reason ?? "Codex finished the turn without generating an image.",
            codexErrorInfo: null,
          };
      if (last) last.status = task.status;
      this.store.touch(task);
      return this.buildResult(task, task.status, this.cachedLimits(), {
        quota: verdict,
        nextStep:
          "No image was produced. Rephrase the prompt (make the request explicit and concrete) and try again, or tell the user.",
      });
    }

    task.status = "completed";
    if (last) last.status = "completed";
    this.store.touch(task);
    const wanted = baseline.images === 0 ? (task.imageRequest?.count ?? 1) : 1;
    return this.buildResult(task, "completed", this.cachedLimits(), {
      quota: verdict,
      nextStep:
        fresh.length < wanted
          ? `Only ${fresh.length} of ${wanted} images were produced. Look at what was generated before using it.`
          : "Look at the image before using it — the preview is attached, or Read the file. Regenerate with a sharper prompt if it misses.",
    });
  }

  /**
   * Codex can finish a turn cleanly while every write it attempted was rejected
   * — a broken sandbox does exactly that. Saying "completed" without flagging it
   * would send the tech lead off to review files that were never written.
   */
  private writeFailureWarning(
    task: TaskRecord,
    view = this.changeView(task, false),
  ): { warning: string } | null {
    // A rejected patch whose file changed anyway (Codex retried through the
    // shell) is not a failure worth reporting.
    const failed = task.failedFileChanges.filter((c) => !view.paths.has(c.path));
    if (failed.length === 0) return null;
    const blocked = failed.map((c) => c.path).join(", ");
    if (view.source === "codex-reported") {
      // Without git snapshots the router cannot tell whether a later shell
      // command wrote the file after all, so it must not claim either way.
      return {
        warning: `Codex's patch for ${blocked} was ${failed[0].reason}. Outside a git repository the router cannot see files written by shell commands, so it cannot tell whether a later command wrote them — check these files on disk before relying on them. If nothing was written, the Codex sandbox is likely misconfigured (see "codex sandbox" and AGENT_ROUTER_SANDBOX).`,
      };
    }
    if (view.files.length === 0) {
      return {
        warning: `Codex could not write any files: every patch was ${failed[0].reason} (${blocked}). Nothing changed on disk. This usually means the Codex sandbox is misconfigured — check "codex sandbox" and consider AGENT_ROUTER_SANDBOX. Do not review these files; they were not created.`,
      };
    }
    return {
      warning: `Codex applied some changes but ${failed.length} patch(es) were rejected (${blocked}). Those files were not written.`,
    };
  }

  /**
   * Codex can hand back an RGBA image whose alpha channel is mostly translucent
   * even when nobody asked for transparency. On a page it shows up as holes or
   * ghost shapes, so it must be flagged rather than passed off as finished.
   */
  private transparencyWarning(task: TaskRecord): { warning: string } | null {
    if (task.kind !== "image" || task.imageRequest?.transparentBackground) return null;
    const affected = task.images.filter((i) => i.transparentPercent > 1);
    if (affected.length === 0) return null;
    const worst = Math.max(...affected.map((i) => i.transparentPercent));
    return {
      warning: `${affected.length} image(s) came back with unrequested transparency (up to ${worst}% of pixels not fully opaque). They will show holes or ghost shapes against some backgrounds. The preview draws transparency as a checkerboard — look at it, and regenerate asking for a solid, fully opaque background if that is not intended.`,
    };
  }

  private nextStepFor(task: TaskRecord): string {
    if (task.kind === "image") {
      return task.images.length > 0
        ? "Look at the image before using it — Read the file to see it."
        : "No image was produced.";
    }
    if (task.status === "completed" && task.failedFileChanges.length > 0) {
      const view = this.changeView(task, false);
      if (view.files.length === 0 && view.source !== "codex-reported") {
        return "Codex reported success but wrote nothing — its patches were rejected. Do not review the listed files. Fix the Codex sandbox, or take the task over yourself.";
      }
      if (view.source === "codex-reported") {
        return "Some of Codex's patches were rejected and, outside a git repository, the router cannot confirm what reached disk. Check the files named in the warning exist before reviewing them.";
      }
    }
    if (task.status === "interrupted") {
      const last = task.interventions[task.interventions.length - 1];
      const why = last && ["auto-interrupted", "forced", "app-server-restarted"].includes(last.action)
        ? ` (${last.reason})`
        : "";
      return `The turn was interrupted${why}. Resume with codex_continue if the work is still wanted, or take it over yourself.`;
    }
    if (task.status !== "completed") {
      return `Task status is ${task.status}.`;
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
    task.turnDeadlineAt = null;
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

  /** Last line of defence: processing an outcome threw. Never leave "running". */
  private finishCrashed(task: TaskRecord, err: Error): TaskResult {
    log(`finishing ${task.taskId} threw: ${err.message}`);
    task.status = "failed";
    task.activeTurnId = null;
    task.turnDeadlineAt = null;
    task.completedAt = task.completedAt ?? new Date().toISOString();
    task.error = { message: `The router failed while processing the result: ${err.message}`, codexErrorInfo: null };
    this.store.touch(task);
    return this.buildResult(task, "failed", this.cachedLimits(), {
      nextStep: "The router hit an internal error. Check the working tree yourself.",
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
      case "agentMessage": {
        // Image turns sometimes echo an empty data URI; it is noise, not a summary.
        const text = typeof item.text === "string" ? item.text.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, "").trim() : "";
        if (text && !task.agentMessages.includes(text)) task.agentMessages.push(text);
        break;
      }
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
      case "imageGeneration":
        this.absorbImage(task, item);
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

  private retire(threadId: string, turnId: string): void {
    const ids = this.retired.get(threadId) ?? new Set<string>();
    ids.add(turnId);
    this.retired.set(threadId, ids);
  }

  /** The turn this notification belongs to, unless it is a stale one from a turn already settled. */
  private activeFor(threadId: string, turnId: string | undefined): ActiveTurn | undefined {
    const active = this.active.get(threadId);
    if (!active) return undefined;
    if (turnId && this.retired.get(threadId)?.has(turnId)) return undefined;
    if (turnId && active.turnIds.size > 0 && !active.turnIds.has(turnId)) return undefined;
    return active;
  }

  private wireNotifications(): void {
    const client = this.client;

    // Any event on a thread proves its turn is alive; this is what the
    // watchdog's stall detection measures against. Kept in memory — the state
    // file is written on the next real change.
    client.on("notification", (_method: string, params: any) => {
      const threadId = params?.threadId;
      if (typeof threadId !== "string") return;
      const task = this.store.byThreadId(threadId);
      if (task && task.status === "running") task.lastActivityAt = new Date().toISOString();
    });

    client.on("notification:turn/started", (params: { threadId: string; turn: Turn }) => {
      const task = this.store.byThreadId(params.threadId);
      if (!task) return;
      // A late start event for a turn already settled belongs to no live turn.
      if (this.retired.get(params.threadId)?.has(params.turn.id)) return;
      this.active.get(params.threadId)?.turnIds.add(params.turn.id);
      task.activeTurnId = params.turn.id;
      const last = task.turns[task.turns.length - 1];
      if (last && last.status === "running") last.turnId = params.turn.id;
      this.store.touch(task);
    });

    client.on("notification:item/started", (params: ItemCompletedNotification) => {
      const task = this.store.byThreadId(params.threadId);
      if (task && params.item?.type === "commandExecution") {
        const command = (params.item as any).command;
        if (command && !task.commands.includes(command)) task.commands.push(command);
      }
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

    client.on("notification:thread/status/changed", (params: ThreadStatusChangedNotification) => {
      const task = this.store.byThreadId(params.threadId);
      if (!task) return;
      this.applyThreadStatus(task, params.status);
      this.store.touch(task);
      if (task.status === "running" && params.status?.type !== "active") {
        // The thread went quiet while a turn is supposedly live. Give
        // turn/completed a moment to arrive, then check the real state.
        const timer = setTimeout(
          () => void this.reconcile(task, `thread reported ${params.status.type}`),
          1500,
        );
        timer.unref?.();
      }
    });

    client.on("notification:turn/completed", (params: TurnCompletedNotification) => {
      const task = this.store.byThreadId(params.threadId);
      const active = this.activeFor(params.threadId, params.turn?.id);
      if (task && active) this.absorbTurnItems(task, params.turn);
      active?.completion.resolve(params.turn);
    });

    client.on("notification:error", (params: ErrorNotification) => {
      if (params.willRetry) {
        debugLog("codex retrying after error:", params.error?.message);
        return;
      }
      // Resolve as a synthetic failed turn: a `turn/completed` may never arrive
      // for fatal errors, and we must not leave the caller hanging.
      this.activeFor(params.threadId, params.turnId)?.completion.resolve(
        syntheticTurn("failed", params.turnId, params.error),
      );
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

    client.on("exit", ({ deliberate }: { deliberate?: boolean }) => {
      const reason = deliberate
        ? "The Codex app-server was restarted; the turn in flight was lost."
        : "The Codex app-server exited unexpectedly; the turn in flight was lost.";
      for (const active of [...this.active.values()]) {
        const task = this.store.get(active.taskId);
        if (task) {
          this.store.intervene(task, "app-server-restarted", reason);
          task.error = { message: reason, codexErrorInfo: "appServerExited" };
        }
        active.completion.resolve(syntheticTurn("interrupted", null));
      }
      for (const task of this.store.running()) {
        if (task.threadId && this.active.has(task.threadId)) continue;
        this.store.intervene(task, "app-server-restarted", reason);
        this.settle(task, syntheticTurn("interrupted", null));
      }
    });
  }

  // ---------------------------------------------------------------- results

  private summarize(task: TaskRecord): string {
    if (task.agentMessages.length > 0) return task.agentMessages[task.agentMessages.length - 1];
    if (task.reasoningSummaries.length > 0) {
      return task.reasoningSummaries[task.reasoningSummaries.length - 1];
    }
    if (task.kind === "image" && task.images.length > 0) {
      return `Generated ${task.images.length} image(s).`;
    }
    return task.status === "running" ? "Codex is working." : "Codex produced no assistant message.";
  }

  private remainingWork(task: TaskRecord): string {
    const open = task.plan.filter((s) => s.status !== "completed");
    if (open.length > 0) {
      return `Unfinished plan steps reported by Codex:\n${open
        .map((s) => `- [${s.status}] ${s.step}`)
        .join("\n")}`;
    }
    const touched = this.changeView(task, false).files.length;
    if (touched === 0) {
      return `Codex made no file changes. The task is effectively untouched: ${task.originalTask}`;
    }
    return `Codex stopped partway through. It touched ${touched} file(s); verify them and complete the remainder of: ${task.originalTask}`;
  }

  /**
   * What the task changed, from the most truthful source available.
   *
   * Codex only tracks edits made through its patch tool; a file written by a
   * shell command produces no event at all, so its own list can come back empty
   * while files sit on disk. Where the router has git snapshots it reads the
   * truth from them instead: the worktree against its base commit, or the
   * working tree between the first pre-turn and the last post-turn checkpoint.
   * Codex-reported paths git cannot see (ignored files) are merged in.
   */
  private changeView(
    task: TaskRecord,
    withDiff: boolean,
  ): { files: string[]; paths: Set<string>; source: "worktree" | "working-tree" | "codex-reported"; diff: string | null } {
    const kinds: Record<string, string> = { A: "add", D: "delete", M: "update", T: "update" };
    const reported = task.changedFiles.map((c) => ({
      path: c.path,
      label: c.movedTo ? `${c.path} -> ${c.movedTo} (${c.kind})` : `${c.path} (${c.kind})`,
    }));
    const merge = (rows: string[], toRelative: (file: string) => string) => {
      const fromDisk = rows.map((row) => {
        const [code, file] = row.split("\t");
        const rel = toRelative(file);
        return { path: rel, label: `${rel} (${kinds[code?.[0] ?? "M"] ?? "update"})` };
      });
      const seen = new Set(fromDisk.map((f) => f.path));
      return [...fromDisk, ...reported.filter((r) => !seen.has(r.path))];
    };
    const finish = (entries: { path: string; label: string }[], source: "worktree" | "working-tree" | "codex-reported", diff: string | null) => ({
      files: entries.map((e) => e.label),
      paths: new Set(entries.map((e) => e.path)),
      source,
      diff,
    });

    if (task.worktree && !task.worktree.removed && task.worktree.baseCommit) {
      const rows = changedFilesAgainstBase(task.worktree.path, task.worktree.baseCommit);
      const root = task.worktree.path;
      const entries = merge(rows, (file) => this.relativeTo(task, root, file));
      const diff = withDiff ? diffAgainstBase(task.worktree.path, task.worktree.baseCommit) || task.diff : null;
      return finish(entries, "worktree", diff);
    }

    if (task.kind === "delegation" && task.status !== "running") {
      const pre = task.checkpoints.find((c) => c.phase === "pre-turn");
      const post = [...task.checkpoints].reverse().find((c) => c.phase === "post-turn");
      if (pre && post && pre.repoRoot === post.repoRoot) {
        const rows = changedFilesBetween(pre.repoRoot, pre.commit, post.commit);
        if (rows !== null) {
          const entries = merge(rows, (file) => this.relativeTo(task, pre.repoRoot, file));
          const diff = withDiff ? diffBetween(pre.repoRoot, pre.commit, post.commit) || task.diff : null;
          return finish(entries, "working-tree", diff);
        }
      }
    }

    return finish(reported, "codex-reported", withDiff ? task.diff : null);
  }

  /** A repo-relative git path, expressed relative to the task's working directory when inside it. */
  private relativeTo(task: TaskRecord, repoRoot: string, file: string): string {
    const rel = path.relative(task.workingDirectory, path.join(repoRoot, file));
    return (rel && !rel.startsWith("..") ? rel : file).split(path.sep).join("/");
  }

  private progressOf(task: TaskRecord): TaskResult["progress"] {
    const turnStarted = task.turns[task.turns.length - 1]?.startedAt ?? task.startedAt;
    const lastMessage = task.agentMessages[task.agentMessages.length - 1] ?? null;
    return {
      health: this.healthOf(task),
      runningSeconds: this.secondsSince(turnStarted),
      idleSeconds: this.secondsSince(task.lastActivityAt),
      lastActivityAt: task.lastActivityAt,
      deadlineAt: task.turnDeadlineAt,
      blockedOn: task.blockedOn,
      currentStep: task.plan.find((s) => s.status === "inProgress")?.step ?? null,
      lastMessage: lastMessage ? lastMessage.slice(0, 280) : null,
      lastCommand: task.commands[task.commands.length - 1] ?? null,
    };
  }

  private buildResult(
    task: TaskRecord,
    status: TaskStatus | "running",
    limits: NormalizedLimits | null,
    opts: { nextStep?: string; quota?: QuotaVerdict; includeDiff?: boolean } = {},
  ): TaskResult {
    const view = this.changeView(task, opts.includeDiff === true && task.kind === "delegation");
    const diff = view.diff ?? undefined;
    const truncated = Boolean(diff && diff.length > DIFF_CHAR_LIMIT);
    const warning =
      this.writeFailureWarning(task, view) ??
      this.transparencyWarning(task) ??
      (opts.quota && opts.quota.state === "low" ? { warning: opts.quota.reason } : null);
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
      changedFiles: view.files,
      ...(task.kind === "delegation" ? { changeSource: view.source } : {}),
      ...(task.failedFileChanges.length > 0
        ? {
            failedFileChanges: task.failedFileChanges.map((c) => `${c.path} (${c.reason})`),
          }
        : {}),
      ...(task.kind === "image"
        ? {
            images: task.images.map(({ id: _id, ...image }) => image),
            ...(task.failedImages.length > 0
              ? { failedImages: task.failedImages.map(({ id: _id, ...f }) => f) }
              : {}),
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
      ...(warning ?? {}),
      ...(task.notes.length > 0 ? { notes: task.notes } : {}),
      ...(status === "running" ? { progress: this.progressOf(task) } : {}),
      ...(task.interventions.length > 0 ? { interventions: task.interventions.slice(-5) } : {}),
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
    if (task.kind === "image") {
      return {
        ...base,
        summary: `No image was generated: ${verdict.reason}`,
        remainingWork: `The image was not generated: ${task.originalTask}`,
        quota: { state: verdict.state, reason: verdict.reason },
        nextStep: `You cannot generate images yourself. Tell the user Codex is out of quota${reset ? ` until ${reset}` : ""}; offer an alternative (an SVG, a placeholder) if the image is not essential. Do not retry in a loop.`,
      };
    }
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
