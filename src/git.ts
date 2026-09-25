import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { debugLog } from "./config.js";

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Identity for checkpoint commits. Snapshots are made with `commit-tree`, which
 * needs an author even though these commits never reach a branch — and the user
 * may have no global `user.email` configured.
 */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "agent-router",
  GIT_AUTHOR_EMAIL: "agent-router@localhost",
  GIT_COMMITTER_NAME: "agent-router",
  GIT_COMMITTER_EMAIL: "agent-router@localhost",
};

/**
 * Git runs synchronously, so a wedged command (a stalled clean filter, a lock
 * held by another tool) would freeze every tool call and the watchdog with it.
 * The deadline turns that into an ordinary, reportable failure.
 */
const GIT_TIMEOUT_MS = 120_000;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, opts: { raw?: boolean } = {}): string {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...GIT_IDENTITY, ...env },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    // NUL-delimited output must not be trimmed: a path may start with a space.
    return opts.raw ? out : out.trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    throw new GitError(`git ${args[0]} failed: ${stderr.trim() || e.message}`, stderr);
  }
}

function tryGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  opts?: { raw?: boolean },
): string | null {
  try {
    return git(cwd, args, env, opts);
  } catch (err) {
    debugLog("git:", (err as Error).message);
    return null;
  }
}

/**
 * Git quotes paths with non-ASCII characters in its line output
 * ("za\305\274..."), so every path listing goes through `-z` instead.
 */
function splitNul(out: string | null): string[] {
  return out ? out.split("\0").filter(Boolean) : [];
}

/** `--name-status -z` emits "A\0path\0M\0path\0"; rebuild "A\tpath" rows. */
function nameStatusRows(out: string): string[] {
  const parts = splitNul(out);
  const rows: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) rows.push(`${parts[i]}\t${parts[i + 1]}`);
  return rows;
}

export interface GitInfo {
  repoRoot: string;
  /** Null on a detached HEAD. */
  branch: string | null;
  /** Null in a repository with no commits yet. */
  head: string | null;
  isWorktree: boolean;
  isDirty: boolean;
}

export function gitInfo(dir: string): GitInfo | null {
  const repoRoot = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return null;
  const branch = tryGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = tryGit(dir, ["rev-parse", "HEAD"]);
  const commonDir = tryGit(dir, ["rev-parse", "--git-common-dir"]) ?? "";
  const gitDir = tryGit(dir, ["rev-parse", "--absolute-git-dir"]) ?? "";
  const status = tryGit(dir, ["status", "--porcelain"]) ?? "";
  return {
    repoRoot: path.resolve(repoRoot),
    branch,
    head,
    // A linked worktree's own git dir sits under the common dir, not at it.
    isWorktree: commonDir !== "" && path.resolve(gitDir) !== path.resolve(dir, commonDir),
    isDirty: status.length > 0,
  };
}

/**
 * Snapshot the working tree — including untracked files — as a dangling commit,
 * without touching the user's index, working tree or any ref.
 *
 * Uses a throwaway `GIT_INDEX_FILE`, so `git add -A` here cannot disturb whatever
 * the user happens to have staged. `git stash create` would be the obvious
 * primitive but it silently omits untracked files, which is exactly what a
 * delegated agent tends to produce.
 *
 * The throwaway index starts as a copy of the real one. From an empty index,
 * `add -A` would skip a tracked file that matches .gitignore, and restoring
 * that snapshot would then leave the file out.
 *
 * Returns null when the directory is not a git repository.
 */
export function snapshotCommit(dir: string, message: string): string | null {
  const info = gitInfo(dir);
  if (!info) return null;
  const tmpIndex = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-idx-")),
    "index",
  );
  try {
    const realIndex = path.resolve(info.repoRoot, git(info.repoRoot, ["rev-parse", "--git-path", "index"]));
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    git(info.repoRoot, ["add", "-A", "--", "."], env);
    const tree = git(info.repoRoot, ["write-tree"], env);
    const args = ["commit-tree", tree, "-m", message];
    if (info.head) args.push("-p", info.head);
    return git(info.repoRoot, args, env);
  } catch (err) {
    debugLog("snapshot failed:", (err as Error).message);
    return null;
  } finally {
    fs.rmSync(path.dirname(tmpIndex), { recursive: true, force: true });
  }
}

/** Every file git considers present: tracked plus untracked-but-not-ignored. */
export function listFiles(repoRoot: string): string[] {
  return splitNul(
    git(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {}, { raw: true }),
  );
}

/**
 * Every file recorded in a commit's tree. Throws when git cannot read it: an
 * empty list would read as "the snapshot was empty" and make every current file
 * look like an extra to delete.
 */
export function treeFiles(repoRoot: string, commit: string): string[] {
  return splitNul(git(repoRoot, ["ls-tree", "-r", "-z", "--name-only", commit], {}, { raw: true }));
}

/** Whether a snapshot commit is still in the object store; git gc may prune it. */
export function commitExists(repoRoot: string, commit: string): boolean {
  return tryGit(repoRoot, ["cat-file", "-e", `${commit}^{tree}`]) !== null;
}

export interface RestoreResult {
  restoredFrom: string;
  filesInSnapshot: number;
  removed: string[];
  leftover: string[];
}

/**
 * Roll the working tree back to a snapshot commit.
 *
 * Restores file *contents* with `git restore --worktree --overlay`, which leaves
 * the index alone and deletes nothing. Without `--overlay` git removes every
 * tracked file missing from the snapshot, including one the user staged after
 * it. Files created after the snapshot are reported as `leftover` and only
 * deleted when `removeExtra` is set, because deleting a file the user wrote by
 * hand is not something to do implicitly.
 *
 * Throws before touching the disk if the snapshot cannot be read.
 */
export function restoreTo(
  repoRoot: string,
  commit: string,
  opts: { removeExtra: boolean },
): RestoreResult {
  if (!commitExists(repoRoot, commit)) {
    throw new Error(
      `Checkpoint commit ${commit} no longer exists in ${repoRoot} (git gc prunes unreferenced commits, by default after two weeks). Nothing was changed.`,
    );
  }
  const inSnapshot = new Set(treeFiles(repoRoot, commit));
  const present = listFiles(repoRoot);
  const extra = present.filter((f) => !inSnapshot.has(f));

  if (inSnapshot.size > 0) {
    git(repoRoot, ["restore", "--source", commit, "--worktree", "--overlay", "--", "."]);
  }

  const removed: string[] = [];
  if (opts.removeExtra) {
    for (const file of extra) {
      const abs = path.join(repoRoot, file);
      try {
        fs.rmSync(abs, { force: true });
        removed.push(file);
      } catch (err) {
        debugLog("could not remove", file, (err as Error).message);
      }
    }
  }

  return {
    restoredFrom: commit,
    filesInSnapshot: inSnapshot.size,
    removed,
    leftover: opts.removeExtra ? extra.filter((f) => !removed.includes(f)) : extra,
  };
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseBranch: string | null;
  baseCommit: string | null;
  repoRoot: string;
}

export function addWorktree(opts: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  base?: string;
}): WorktreeInfo {
  const info = gitInfo(opts.repoRoot);
  if (!info) throw new Error(`${opts.repoRoot} is not a git repository.`);
  if (!info.head) {
    throw new Error(
      "Cannot create a worktree in a repository with no commits. Make an initial commit first, or delegate with isolation \"none\".",
    );
  }
  fs.mkdirSync(path.dirname(opts.worktreePath), { recursive: true });
  const base = opts.base ?? info.branch ?? info.head;
  git(info.repoRoot, ["worktree", "add", "-b", opts.branch, opts.worktreePath, base]);
  return {
    path: path.resolve(opts.worktreePath),
    branch: opts.branch,
    baseBranch: opts.base ?? info.branch,
    baseCommit: tryGit(opts.worktreePath, ["rev-parse", "HEAD"]),
    repoRoot: info.repoRoot,
  };
}

export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  opts: { force: boolean; deleteBranch?: string | null },
): void {
  const args = ["worktree", "remove", worktreePath];
  if (opts.force) args.push("--force");
  git(repoRoot, args);
  if (opts.deleteBranch) {
    tryGit(repoRoot, ["branch", "-D", opts.deleteBranch]);
  }
}

/** Commit everything in a worktree onto its own branch. Returns null if clean. */
export function commitAll(dir: string, message: string): string | null {
  const info = gitInfo(dir);
  if (!info) throw new Error(`${dir} is not a git repository.`);
  git(info.repoRoot, ["add", "-A", "--", "."]);
  const staged = tryGit(info.repoRoot, ["diff", "--cached", "--name-only", "-z"], undefined, { raw: true });
  if (!staged) return null;
  git(info.repoRoot, ["commit", "-m", message, "--no-verify"]);
  return tryGit(info.repoRoot, ["rev-parse", "HEAD"]);
}

/**
 * Cumulative changes in a worktree against the commit it branched from,
 * including files that are still untracked — the per-turn diff only covers one
 * turn. One snapshot serves both the file list and the diff.
 */
export function changesAgainstBase(
  dir: string,
  baseCommit: string,
  withDiff: boolean,
): { files: string[]; diff: string } {
  const info = gitInfo(dir);
  if (!info) return { files: [], diff: "" };
  const snapshot = snapshotCommit(dir, "agent-router: diff snapshot");
  if (!snapshot) return { files: [], diff: "" };
  return {
    files: changedFilesBetween(info.repoRoot, baseCommit, snapshot) ?? [],
    diff: withDiff ? diffBetween(info.repoRoot, baseCommit, snapshot) : "",
  };
}

/**
 * What changed on disk between two snapshots (e.g. before and after a turn).
 * Unlike Codex's own change tracking this also sees files written through shell
 * commands, which never produce a patch event.
 */
export function changedFilesBetween(repoRoot: string, from: string, to: string): string[] | null {
  const out = tryGit(repoRoot, ["diff", "--name-status", "-z", "--no-renames", from, to], undefined, {
    raw: true,
  });
  // null means git could not answer — distinct from "nothing changed".
  return out === null ? null : nameStatusRows(out);
}

export function diffBetween(repoRoot: string, from: string, to: string): string {
  return tryGit(repoRoot, ["diff", "--no-renames", from, to]) ?? "";
}

