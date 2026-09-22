import fs from "node:fs";
import path from "node:path";
import { config, debugLog } from "./config.js";
import type { NormalizedLimits } from "./limits.js";
import type { TurnPlanStep } from "./protocol.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "quota_exhausted";

export interface TaskFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  movedTo?: string | null;
}

export type TaskKind = "delegation" | "review" | "image";
export type Isolation = "none" | "worktree";

export interface TaskWorktree {
  path: string;
  branch: string;
  baseBranch: string | null;
  baseCommit: string | null;
  repoRoot: string;
  /** Set once the worktree has been torn down; the branch may still exist. */
  removed: boolean;
}

export interface Checkpoint {
  id: string;
  label: string;
  /** Dangling commit holding the snapshot; see git.snapshotCommit. */
  commit: string;
  repoRoot: string;
  phase: "pre-turn" | "post-turn" | "pre-restore";
  turnIndex: number;
  createdAt: string;
}

export interface GeneratedImage {
  /** Codex item id. */
  id: string;
  path: string;
  bytes: number;
  width: number | null;
  height: number | null;
  mimeType: string;
  revisedPrompt: string | null;
  /** Share of pixels that are not fully opaque; 0 for images without alpha. */
  transparentPercent: number;
}

/** Something the watchdog or a forced interrupt did to a task, kept for the record. */
export interface Intervention {
  at: string;
  action: "reconciled" | "stalled" | "auto-interrupted" | "forced" | "app-server-restarted";
  reason: string;
}

export interface TaskTurn {
  turnId: string | null;
  instruction: string;
  startedAt: string;
  endedAt: string | null;
  status: TaskStatus;
}

export interface TaskRecord {
  taskId: string;
  kind: TaskKind;
  threadId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  originalTask: string;
  /** Latest instruction sent — differs from `originalTask` after codex_continue. */
  currentInstruction: string;
  scope: string | null;
  /** Directory Codex was actually given — inside the worktree when isolated. */
  workingDirectory: string;
  /** Directory the caller asked about, before any worktree redirection. */
  requestedDirectory: string;
  isolation: Isolation;
  worktree: TaskWorktree | null;
  checkpoints: Checkpoint[];
  /** For review tasks: what was reviewed. */
  reviewOf: { taskId: string | null; target: string } | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Id of the turn currently in flight, needed for turn/interrupt. */
  activeTurnId: string | null;
  turns: TaskTurn[];

  // Accumulated output from the Codex side.
  agentMessages: string[];
  reasoningSummaries: string[];
  commands: string[];
  changedFiles: TaskFileChange[];
  /** Writes Codex attempted that the sandbox or a reviewer rejected. */
  failedFileChanges: (TaskFileChange & { reason: string })[];
  diff: string | null;
  plan: TurnPlanStep[];
  tokenUsage: { total: number | null; contextWindow: number | null } | null;

  error: { message: string; codexErrorInfo: unknown } | null;
  quotaAtFailure: NormalizedLimits | null;

  // Liveness, maintained by the router while a turn runs.
  /** Last event of any kind Codex sent for this thread. */
  lastActivityAt: string | null;
  /** Past this the watchdog interrupts the turn. Null means no ceiling. */
  turnDeadlineAt: string | null;
  /** Last thread status Codex reported (idle, active, systemError, notLoaded). */
  threadStatus: string | null;
  /** Set while Codex waits on an approval or user input that nobody can give. */
  blockedOn: string | null;
  blockedSince: string | null;
  interventions: Intervention[];
  /** Model-policy notes (capped effort, off-policy model) to surface once. */
  notes: string[];

  // Image generation.
  images: GeneratedImage[];
  failedImages: { id: string; reason: string; resetsAt: string | null }[];
  imageRequest: {
    outputPaths: string[];
    count: number;
    transparentBackground: boolean;
    overwrite: boolean;
  } | null;
  /** Image and failure counts when the current turn began. */
  imageBaseline: { images: number; failed: number } | null;
}

let counter = 0;

export function newTaskId(kind: TaskKind = "delegation"): string {
  counter += 1;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const prefix = kind === "review" ? "review" : "codex";
  return `${prefix}-${stamp}-${String(counter).padStart(3, "0")}`;
}

/**
 * In-memory registry of delegated tasks, mirrored to disk on a best-effort basis
 * so `codex_task_status` still says something useful after a router restart.
 */
export class TaskStore {
  private tasks = new Map<string, TaskRecord>();

  constructor() {
    this.load();
  }

  create(init: {
    originalTask: string;
    scope: string | null;
    workingDirectory: string;
    model: string | null;
    reasoningEffort: string | null;
    kind?: TaskKind;
    isolation?: Isolation;
    reviewOf?: { taskId: string | null; target: string } | null;
  }): TaskRecord {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId: newTaskId(init.kind ?? "delegation"),
      kind: init.kind ?? "delegation",
      threadId: null,
      model: init.model,
      reasoningEffort: init.reasoningEffort,
      originalTask: init.originalTask,
      currentInstruction: init.originalTask,
      scope: init.scope,
      workingDirectory: init.workingDirectory,
      requestedDirectory: init.workingDirectory,
      isolation: init.isolation ?? "none",
      worktree: null,
      checkpoints: [],
      reviewOf: init.reviewOf ?? null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      activeTurnId: null,
      turns: [],
      agentMessages: [],
      reasoningSummaries: [],
      commands: [],
      changedFiles: [],
      failedFileChanges: [],
      diff: null,
      plan: [],
      tokenUsage: null,
      error: null,
      quotaAtFailure: null,
      lastActivityAt: null,
      turnDeadlineAt: null,
      threadStatus: null,
      blockedOn: null,
      blockedSince: null,
      interventions: [],
      notes: [],
      images: [],
      failedImages: [],
      imageRequest: null,
      imageBaseline: null,
    };
    this.tasks.set(record.taskId, record);
    this.persist();
    return record;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  byThreadId(threadId: string): TaskRecord | undefined {
    for (const task of this.tasks.values()) {
      if (task.threadId === threadId) return task;
    }
    return undefined;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  touch(task: TaskRecord): void {
    task.updatedAt = new Date().toISOString();
    this.persist();
  }

  intervene(task: TaskRecord, action: Intervention["action"], reason: string): void {
    task.interventions.push({ at: new Date().toISOString(), action, reason });
    this.touch(task);
  }

  running(): TaskRecord[] {
    return [...this.tasks.values()].filter((t) => t.status === "running");
  }

  addCheckpoint(task: TaskRecord, checkpoint: Checkpoint): void {
    task.checkpoints.push(checkpoint);
    this.touch(task);
  }

  /** Merge a file change from a `fileChange` item, keeping one entry per path. */
  recordFileChange(task: TaskRecord, change: TaskFileChange): void {
    change = { ...change, path: this.relativize(task, change.path) };
    const existing = task.changedFiles.find((c) => c.path === change.path);
    if (existing) {
      existing.kind = change.kind;
      if (change.movedTo) existing.movedTo = change.movedTo;
      return;
    }
    task.changedFiles.push(change);
  }

  /**
   * Backstop for files that only show up in the turn diff. The diff cannot tell
   * an add from an update reliably, so it must never overwrite a kind that a
   * `fileChange` item already established.
   */
  recordFileFromDiff(task: TaskRecord, filePath: string): void {
    const rel = this.relativize(task, filePath);
    if (task.changedFiles.some((c) => c.path === rel)) return;
    task.changedFiles.push({ path: rel, kind: "update" });
  }

  /**
   * A write Codex attempted but could not apply. Reporting these as changes
   * would tell the tech lead a file exists when it does not.
   */
  recordFailedFileChange(task: TaskRecord, change: TaskFileChange, reason: string): void {
    const rel = this.relativize(task, change.path);
    if (task.failedFileChanges.some((c) => c.path === rel)) return;
    task.failedFileChanges.push({ ...change, path: rel, reason });
  }

  /**
   * Codex reports `fileChange` paths as absolute but diffs as repo-relative;
   * without normalizing, one file shows up as two entries.
   */
  private relativize(task: TaskRecord, filePath: string): string {
    if (!path.isAbsolute(filePath)) return filePath.split("\\").join("/");
    const rel = path.relative(task.workingDirectory, filePath);
    if (!rel || rel.startsWith("..")) return filePath;
    return rel.split("\\").join("/");
  }

  private load(): void {
    try {
      if (!fs.existsSync(config.stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(config.stateFile, "utf8")) as {
        tasks?: TaskRecord[];
      };
      for (const stored of raw.tasks ?? []) {
        const task = migrate(stored);
        // A task that was in flight when the router died can never resume its
        // turn stream; surface it as interrupted rather than eternally running.
        if (task.status === "running" || task.status === "pending") {
          task.status = "interrupted";
          task.activeTurnId = null;
          task.interventions.push({
            at: new Date().toISOString(),
            action: "app-server-restarted",
            reason: "The router restarted while this turn was running.",
          });
        }
        this.tasks.set(task.taskId, task);
      }
      debugLog(`loaded ${this.tasks.size} task(s) from ${config.stateFile}`);
    } catch (err) {
      debugLog("could not load task state:", (err as Error).message);
    }
  }

  private persistTimer: NodeJS.Timeout | null = null;

  /**
   * Coalesce writes: a busy turn emits an event every few milliseconds, and
   * rewriting the whole state file on each one is wasted I/O.
   */
  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, 250);
    this.persistTimer.unref?.();
  }

  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
      // Keep the file bounded; old tasks are of no further use.
      const tasks = this.list().slice(0, 200);
      const tmp = `${config.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ tasks }, null, 2), "utf8");
      // Write-then-rename, so a crash mid-write cannot leave a truncated file.
      fs.renameSync(tmp, config.stateFile);
    } catch (err) {
      debugLog("could not persist task state:", (err as Error).message);
    }
  }
}

/** Fill in fields added by later versions, so an old state file still loads. */
function migrate(task: TaskRecord): TaskRecord {
  const defaults: Partial<TaskRecord> = {
    kind: "delegation",
    isolation: "none",
    worktree: null,
    checkpoints: [],
    reviewOf: null,
    failedFileChanges: [],
    lastActivityAt: null,
    turnDeadlineAt: null,
    threadStatus: null,
    blockedOn: null,
    blockedSince: null,
    interventions: [],
    notes: [],
    images: [],
    failedImages: [],
    imageRequest: null,
    imageBaseline: null,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if ((task as any)[key] === undefined) (task as any)[key] = value;
  }
  if (!task.requestedDirectory) task.requestedDirectory = task.workingDirectory;
  return task;
}

/** Files touched, derived from fileChange items and, as a fallback, the turn diff. */
export function filesFromDiff(diff: string | null): string[] {
  if (!diff) return [];
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      files.add(m[2]);
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus && plus[1] !== "/dev/null") files.add(plus[1]);
  }
  return [...files];
}
