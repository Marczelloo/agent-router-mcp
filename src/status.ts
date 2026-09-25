import fs from "node:fs";
import path from "node:path";
import type { TaskRecord } from "./tasks.js";

/** Finished tasks stay listed this long, so a tool that starts later still sees how they ended. */
const RECENT_MS = 2 * 60 * 60 * 1000;
const MAX_TASKS = 50;

export interface PublicTask {
  taskId: string;
  threadId: string | null;
  kind: string;
  title: string;
  status: string;
  model: string | null;
  workingDirectory: string;
  startedAt: string | null;
  updatedAt: string;
  lastActivityAt: string | null;
  blocked: boolean;
}

/**
 * The public status file (`~/.agent-router/status.json`, version 1). Unlike the
 * internal state file it carries no task text beyond a short title, and no
 * diffs, commands or messages. Health is left to the reader: the file is only
 * rewritten on changes, so a stored health would go stale while a task is quiet.
 */
export interface PublicStatus {
  version: 1;
  updatedAt: string;
  stallSeconds: number;
  tasks: PublicTask[];
}

/** First non-empty line, at most 80 characters. */
export function titleOf(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const chars = [...line];
  return chars.length <= 80 ? line : chars.slice(0, 79).join("") + "…";
}

export function publicStatus(tasks: TaskRecord[], now: number, stallSeconds: number): PublicStatus {
  const live = (t: TaskRecord) => t.status === "running" || t.status === "pending";
  const picked = tasks
    .filter((t) => live(t) || now - Date.parse(t.updatedAt) <= RECENT_MS)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_TASKS);
  return {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    stallSeconds,
    tasks: picked.map((t) => ({
      taskId: t.taskId,
      threadId: t.threadId,
      kind: t.kind,
      title: titleOf(t.originalTask),
      status: t.status,
      model: t.model,
      workingDirectory: t.workingDirectory,
      startedAt: t.startedAt,
      updatedAt: t.updatedAt,
      lastActivityAt: t.lastActivityAt,
      blocked: t.blockedOn != null,
    })),
  };
}

/** Write-then-rename with a per-process temp name: several routers write this file. */
export function writeStatus(file: string, status: PublicStatus): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status), "utf8");
  fs.renameSync(tmp, file);
}
