#!/usr/bin/env node
/**
 * End-to-end tests for the Agent Router MCP server.
 *
 * Each case boots the real MCP server over stdio, but points it at
 * test/fake-app-server.mjs instead of `codex app-server`, so the whole
 * router — JSON-RPC client, notification wiring, quota policy, task store —
 * is exercised without spending Codex quota.
 *
 *   node test/run-tests.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");
const fakeServer = path.join(here, "fake-app-server.mjs");

if (!fs.existsSync(entry)) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function withServer(scenario, env, fn) {
  const stateFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-test-")),
    "tasks.json",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      AGENT_ROUTER_CODEX_BIN: process.execPath,
      AGENT_ROUTER_CODEX_ARGS: JSON.stringify([fakeServer]),
      AGENT_ROUTER_STATE_FILE: stateFile,
      FAKE_SCENARIO: scenario,
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "agent-router-tests", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text).join("\n");
    try {
      return { isError: res.isError ?? false, data: JSON.parse(text), text };
    } catch {
      return { isError: res.isError ?? false, data: null, text };
    }
  };
  try {
    await fn(call);
  } finally {
    await client.close();
  }
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cwd-"));
const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-wt-"));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** A throwaway repository with one commit, an ignored directory, and one tracked file. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-repo-"));
  const g = (args, at) =>
    execFileSync("git", args, { cwd: at ?? dir, encoding: "utf8", env: GIT_ENV });
  g(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "app.js"), "original");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/");
  fs.mkdirSync(path.join(dir, "ignored"));
  fs.writeFileSync(path.join(dir, "ignored", "keep.txt"), "keep me");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  return { dir, g };
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// ---------------------------------------------------------------- tests

console.log("\ncodex_get_models");
await withServer("success", {}, async (call) => {
  const { data } = await call("codex_get_models");
  check("returns models from the live catalogue", data.models?.length === 2);
  check("marks the default model", data.defaultModel === "fake-large");
  check(
    "exposes per-model reasoning efforts",
    JSON.stringify(data.models[0].reasoningEfforts.map((r) => r.effort)) ===
      JSON.stringify(["low", "high"]),
  );
  check("small model advertises only its own efforts", data.models[1].reasoningEfforts.length === 1);
});

console.log("\ncodex_get_limits");
await withServer("success", {}, async (call) => {
  const { data } = await call("codex_get_limits");
  check("labels the 300-min window as 5h", data.fiveHour?.window === "5h");
  check("labels the 10080-min window as weekly", data.weekly?.window === "weekly");
  check("5h window came from the primary slot", data.fiveHour?.slot === "primary");
  check("computes remainingPercent", data.fiveHour?.remainingPercent === 88);
  check("exposes resetsAt as ISO", typeof data.fiveHour?.resetsAt === "string");
  check("rateLimitReached is false when under limit", data.rateLimitReached === false);
  check("picks the tightest window", data.tightest?.window === "weekly");
  check("verdict allows delegation", data.quota?.state === "ok" && data.quota?.canDelegate === true);
});

console.log("\ncodex_delegate — happy path");
await withServer("success", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Create hello.txt",
    workingDirectory: cwd,
    scope: "only hello.txt",
    model: "fake-large",
    reasoningEffort: "high",
    waitSeconds: 20,
  });
  check("status is completed", data.status === "completed", `got ${data.status}`);
  check("carries a Codex threadId", typeof data.threadId === "string" && data.threadId.length > 0);
  check("records the chosen model", data.model === "fake-large");
  check("records the chosen reasoning effort", data.reasoningEffort === "high");
  check("summary is the final agent message", data.summary?.includes("Created hello.txt"));
  check(
    "changedFiles collected from fileChange items",
    JSON.stringify(data.changedFiles) === JSON.stringify(["hello.txt (add)"]),
    JSON.stringify(data.changedFiles),
  );
  check("commands collected", data.commands?.includes("cat hello.txt"));
  check("plan collected", data.plan?.length === 2);
  check("diff returned", typeof data.diff === "string" && data.diff.includes("hello from codex"));
  check("originalTask preserved", data.originalTask === "Create hello.txt");
  check("scope preserved", data.scope === "only hello.txt");
  check("timestamps present", Boolean(data.timestamps?.createdAt && data.timestamps?.completedAt));

  const status = await call("codex_task_status", { taskId: data.taskId });
  check("codex_task_status finds the task", status.data.taskId === data.taskId);
  check("status survives as completed", status.data.status === "completed");

  const list = await call("codex_task_status");
  check("codex_task_status with no id lists tasks", Array.isArray(list.data.tasks));
});

console.log("\ncodex_continue");
await withServer("success", {}, async (call) => {
  const first = await call("codex_delegate", {
    task: "Create hello.txt",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  const second = await call("codex_continue", {
    taskId: first.data.taskId,
    instruction: "Now add a trailing newline.",
    waitSeconds: 20,
  });
  check("reuses the same taskId", second.data.taskId === first.data.taskId);
  check("reuses the same Codex thread", second.data.threadId === first.data.threadId);
  check("completes the follow-up turn", second.data.status === "completed");
  check("originalTask still points at the first instruction", second.data.originalTask === "Create hello.txt");

  const unknown = await call("codex_continue", { taskId: "does-not-exist", instruction: "hi" });
  check("rejects an unknown taskId", unknown.isError === true);
});

console.log("\nquota preflight (delegation refused before any thread starts)");
await withServer("success", { AGENT_ROUTER_QUOTA_BLOCK_PERCENT: "95" }, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Big refactor",
    workingDirectory: cwd,
    waitSeconds: 10,
  });
  check("status is quota_exhausted", data.status === "quota_exhausted", `got ${data.status}`);
  check("no Codex thread was started", data.threadId === null);
  check("originalTask returned for handoff", data.originalTask === "Big refactor");
  check("remainingWork tells Claude to finish it", typeof data.remainingWork === "string");
  check("limits attached to the handoff", Array.isArray(data.limits?.windows));
  check("changedFiles is an empty array", JSON.stringify(data.changedFiles) === "[]");
  check("nextStep forbids waiting for a reset", /do not wait/i.test(data.nextStep ?? ""));
});

console.log("\nquota low warning");
await withServer("success", { AGENT_ROUTER_QUOTA_LOW_PERCENT: "70" }, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Create hello.txt",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  check("still delegates", data.status === "completed", `got ${data.status}`);
  check("warns about low quota", typeof data.warning === "string" && /low/i.test(data.warning));
});

console.log("\nquota exhausted mid-turn (handoff)");
await withServer("quota_midturn", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Long task",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  check("status is quota_exhausted", data.status === "quota_exhausted", `got ${data.status}`);
  check("thread id preserved for a later resume", typeof data.threadId === "string");
  check("carries the Codex error", data.error?.codexErrorInfo === "usageLimitExceeded");
  check("remainingWork present", typeof data.remainingWork === "string");
  check("fresh limits show the account as limited", data.limits?.rateLimitReached === true);
  check("nextStep forbids retrying Codex", /do not retry/i.test(data.nextStep ?? ""));
});

console.log("\nturn failure that is not a quota problem");
await withServer("fail", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Broken task",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  check("status is failed", data.status === "failed", `got ${data.status}`);
  check("not misclassified as quota", data.status !== "quota_exhausted");
  check("error message surfaced", data.error?.message === "compile error");
});

console.log("\nlong-running turn -> pollable handle + interrupt");
await withServer("slow", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Never ending",
    workingDirectory: cwd,
    waitSeconds: 1,
  });
  check("returns running instead of blocking", data.status === "running", `got ${data.status}`);
  check("hands back a pollable taskId", typeof data.taskId === "string");
  check("nextStep mentions polling", /codex_task_status/.test(data.nextStep ?? ""));

  const status = await call("codex_task_status", { taskId: data.taskId });
  check("task is still running when polled", status.data.status === "running");

  const stopped = await call("codex_interrupt", { taskId: data.taskId });
  check("interrupt reports interrupted", stopped.data.status === "interrupted", `got ${stopped.data.status}`);
});

console.log("\ninput validation");
await withServer("success", {}, async (call) => {
  const badDir = await call("codex_delegate", {
    task: "x",
    workingDirectory: path.join(cwd, "nope-does-not-exist"),
  });
  check("rejects a missing workingDirectory", badDir.isError === true);

  const badModel = await call("codex_delegate", {
    task: "x",
    workingDirectory: cwd,
    model: "not-a-real-model",
  });
  check("rejects an unknown model", badModel.isError === true);
  check("lists valid models in the error", /fake-large/.test(badModel.text));

  const badEffort = await call("codex_delegate", {
    task: "x",
    workingDirectory: cwd,
    model: "fake-small",
    reasoningEffort: "high",
  });
  check("rejects an effort the model does not support", badEffort.isError === true);

  const unknownTask = await call("codex_task_status", { taskId: "nope" });
  check("rejects an unknown taskId", unknownTask.isError === true);
});

console.log("");
console.log("concurrent delegations");
await withServer("success", {}, async (call) => {
  const [a, b] = await Promise.all([
    call("codex_delegate", { task: "Task A", workingDirectory: cwd, waitSeconds: 20 }),
    call("codex_delegate", { task: "Task B", workingDirectory: cwd, waitSeconds: 20 }),
  ]);
  check("both complete", a.data.status === "completed" && b.data.status === "completed",
    `${a.data.status} / ${b.data.status}`);
  check("each gets its own taskId", a.data.taskId !== b.data.taskId);
  // Turn completion is routed by threadId, so two in-flight turns must never
  // share one — otherwise one delegation would resolve with the other's result.
  check("each gets its own Codex thread", a.data.threadId !== b.data.threadId,
    `${a.data.threadId} / ${b.data.threadId}`);
  check("results are not crossed", a.data.originalTask === "Task A" && b.data.originalTask === "Task B");

  const list = await call("codex_task_status");
  check("both are tracked", list.data.tasks.length >= 2);
});

console.log("");
console.log("writes rejected by the sandbox");
await withServer("write_blocked", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Create greeting.txt",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  check("the turn still reports as completed", data.status === "completed", data.status);
  check(
    "a rejected patch is NOT reported as a changed file",
    JSON.stringify(data.changedFiles) === "[]",
    JSON.stringify(data.changedFiles),
  );
  check(
    "it is reported separately as a failed write",
    (data.failedFileChanges ?? []).some((f) => f.startsWith("greeting.txt")),
    JSON.stringify(data.failedFileChanges),
  );
  check("a warning says nothing landed on disk", /could not write any files/i.test(data.warning ?? ""));
  check("the warning names the likely cause", /sandbox/i.test(data.warning ?? ""));
  check(
    "nextStep tells the lead not to review phantom files",
    /do not review/i.test(data.nextStep ?? ""),
    data.nextStep,
  );
});

console.log("");
console.log("git checkpoints");
await withServer("success", {}, async (call) => {
  const repo = makeRepo();
  const { data } = await call("codex_delegate", {
    task: "Touch the app",
    workingDirectory: repo.dir,
    waitSeconds: 20,
  });
  check("a checkpoint is taken before and after the turn", data.checkpoints.length === 2, JSON.stringify(data.checkpoints));
  check("phases are labelled", data.checkpoints[0].phase === "pre-turn" && data.checkpoints[1].phase === "post-turn");

  const listed = await call("codex_checkpoints", { taskId: data.taskId });
  check("codex_checkpoints reports them", listed.data.checkpoints.length === 2);
  check("checkpointing is reported as on", listed.data.checkpointing === "on");
  check("each checkpoint names a commit", /^[0-9a-f]{40}$/.test(listed.data.checkpoints[0].commit));

  // Simulate a turn that made things worse.
  const appFile = path.join(repo.dir, "app.js");
  const junkFile = path.join(repo.dir, "junk.txt");
  fs.writeFileSync(appFile, "BROKEN");
  fs.writeFileSync(junkFile, "junk");

  const restored = await call("codex_restore", { taskId: data.taskId, checkpointId: "cp-1" });
  check("restore succeeds", restored.data.status === "restored", restored.text.slice(0, 200));
  check("tracked file content is rolled back", fs.readFileSync(appFile, "utf8") === "original");
  check("files created after the checkpoint are kept by default", fs.existsSync(junkFile));
  check("those files are reported as leftovers", restored.data.leftoverFiles.includes("junk.txt"));
  check("a safety checkpoint is captured first", typeof restored.data.safetyCheckpoint?.id === "string");
  check("the leftover hint is present", typeof restored.data.hint === "string");

  const safetyId = restored.data.safetyCheckpoint.id;

  const purged = await call("codex_restore", {
    taskId: data.taskId,
    checkpointId: "cp-1",
    removeUntracked: true,
  });
  check("removeUntracked deletes the extra file", !fs.existsSync(junkFile));
  check("the deletion is reported", purged.data.removedFiles.includes("junk.txt"));
  check("gitignored files are never touched", fs.existsSync(path.join(repo.dir, "ignored", "keep.txt")));

  const undone = await call("codex_restore", {
    taskId: data.taskId,
    checkpointId: safetyId,
    removeUntracked: true,
  });
  check("a restore is itself undoable", undone.data.status === "restored");
  check("the pre-restore content comes back", fs.readFileSync(appFile, "utf8") === "BROKEN");
  check("and so do its untracked files", fs.existsSync(junkFile));

  const bogus = await call("codex_restore", { taskId: data.taskId, checkpointId: "cp-999" });
  check("rejects an unknown checkpoint", bogus.isError === true);
  check("lists the valid checkpoint ids", /cp-1/.test(bogus.text));

  // The user's staging area must survive all of that untouched.
  check("the user index was never disturbed", repo.g(["diff", "--cached", "--name-only"]).trim() === "");
});

console.log("");
console.log("checkpoints outside a git repository");
await withServer("success", {}, async (call) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ar-plain-"));
  const { data } = await call("codex_delegate", {
    task: "Work without git",
    workingDirectory: plain,
    waitSeconds: 20,
  });
  check("delegation still works", data.status === "completed");
  check("no checkpoints are invented", data.checkpoints.length === 0);
  const listed = await call("codex_checkpoints", { taskId: data.taskId });
  check("the reason is explained", /not a git repository/.test(listed.data.checkpointing));
});

console.log("");
console.log("worktree isolation");
await withServer("success", { AGENT_ROUTER_WORKTREE_ROOT: worktreeRoot }, async (call) => {
  const repo = makeRepo();
  const { data } = await call("codex_delegate", {
    task: "Build a feature",
    workingDirectory: repo.dir,
    isolation: "worktree",
    waitSeconds: 20,
  });
  check("delegation completed", data.status === "completed", data.text ?? data.status);
  check("isolation is recorded", data.isolation === "worktree");
  check("a dedicated branch is used", data.worktree?.branch === "agent-router/" + data.taskId);
  check("codex is pointed at the worktree", samePath(data.workingDirectory, data.worktree?.path));
  check("the requested directory is remembered", samePath(data.requestedDirectory, repo.dir));
  check("the worktree lives outside the repo", !samePath(path.dirname(data.worktree.path), repo.dir));
  check("the worktree exists on disk", fs.existsSync(data.worktree.path));
  check("the result explains the isolation", /Isolated on branch/.test(data.integration ?? ""));
  check("nextStep points at codex_worktree", /codex_worktree/.test(data.nextStep ?? ""));

  // Stand in for the work Codex would have done inside the worktree.
  fs.writeFileSync(path.join(data.worktree.path, "feature.js"), "shipped");
  fs.writeFileSync(path.join(data.worktree.path, "app.js"), "rewritten");

  check("the user working tree is untouched", fs.readFileSync(path.join(repo.dir, "app.js"), "utf8") === "original");
  check("and gains no new files", !fs.existsSync(path.join(repo.dir, "feature.js")));

  const status = await call("codex_task_status", { taskId: data.taskId });
  check(
    "status reports the cumulative worktree diff, not just the last turn",
    status.data.changedFiles.includes("feature.js (add)") &&
      status.data.changedFiles.includes("app.js (update)"),
    JSON.stringify(status.data.changedFiles),
  );

  const refused = await call("codex_worktree", { taskId: data.taskId, action: "remove" });
  check("removing a dirty worktree is refused", refused.isError === true);
  check("the refusal explains how to proceed", /commit/i.test(refused.text));

  const committed = await call("codex_worktree", { taskId: data.taskId, action: "commit" });
  check("committing works", committed.data.status === "committed", committed.text.slice(0, 200));
  check("the commit is on the task branch", committed.data.branch === data.worktree.branch);
  check("the merge command is handed back", /git merge/.test(committed.data.integration ?? ""));
  check(
    "the router did not merge into the user branch",
    fs.readFileSync(path.join(repo.dir, "app.js"), "utf8") === "original",
  );

  const removed = await call("codex_worktree", { taskId: data.taskId, action: "remove" });
  check("a clean worktree can be removed", removed.data.status === "removed");
  check("it is gone from disk", !fs.existsSync(data.worktree.path));
  check("the branch survives for merging", repo.g(["branch", "--list"]).includes(data.worktree.branch));

  const afterRemoval = await call("codex_continue", {
    taskId: data.taskId,
    instruction: "keep going",
  });
  check("continuing into a removed worktree is refused", afterRemoval.isError === true);
});

console.log("");
console.log("worktree validation");
await withServer("success", { AGENT_ROUTER_WORKTREE_ROOT: worktreeRoot }, async (call) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ar-nogit-"));
  const noRepo = await call("codex_delegate", {
    task: "x",
    workingDirectory: plain,
    isolation: "worktree",
  });
  check("worktree isolation needs a git repository", noRepo.isError === true);
  check("the error suggests isolation none", /isolation .*none/.test(noRepo.text));

  const repo = makeRepo();
  const inPlace = await call("codex_delegate", {
    task: "x",
    workingDirectory: repo.dir,
    waitSeconds: 20,
  });
  const noWorktree = await call("codex_worktree", { taskId: inPlace.data.taskId, action: "commit" });
  check("codex_worktree rejects a non-isolated task", noWorktree.isError === true);
  check("and says why", /isolation/.test(noWorktree.text));

  const named = await call("codex_delegate", {
    task: "x",
    workingDirectory: repo.dir,
    isolation: "worktree",
    branch: "feature/custom-name",
    waitSeconds: 20,
  });
  check("a custom branch name is honoured", named.data.worktree?.branch === "feature/custom-name");
});

console.log("");
console.log("codex_review (Claude -> Codex)");
await withServer("success", {}, async (call) => {
  const repo = makeRepo();
  const { data } = await call("codex_review", {
    workingDirectory: repo.dir,
    waitSeconds: 20,
  });
  check("review completes", data.status === "completed", data.status);
  check("it is recorded as a review task", data.kind === "review");
  check("the task id is namespaced", data.taskId.startsWith("review-"));
  check("findings come back in the summary", /REVIEW FINDINGS/.test(data.summary));
  check(
    "the default target is uncommitted changes",
    /"type":"uncommittedChanges"/.test(data.summary),
    data.summary,
  );
  check("the reviewer runs read-only", /"read-only"/.test(data.summary), data.summary);
  check("the reviewer is told not to edit", /do not edit files/i.test(data.summary));
  check("nextStep says nothing was changed", /nothing was changed/i.test(data.nextStep ?? ""));

  const onBranch = await call("codex_review", {
    workingDirectory: repo.dir,
    target: "baseBranch",
    branch: "main",
    waitSeconds: 20,
  });
  check("baseBranch target maps through", /"baseBranch"/.test(onBranch.data.summary));
  check("the branch is passed", /"branch":"main"/.test(onBranch.data.summary));

  const onCommit = await call("codex_review", {
    workingDirectory: repo.dir,
    target: "commit",
    commit: "deadbeef",
    waitSeconds: 20,
  });
  check("commit target maps through", /"sha":"deadbeef"/.test(onCommit.data.summary));

  const custom = await call("codex_review", {
    workingDirectory: repo.dir,
    target: "custom",
    instructions: "Only look at error handling.",
    waitSeconds: 20,
  });
  check("custom target carries the instructions", /Only look at error handling/.test(custom.data.summary));

  const guided = await call("codex_review", {
    workingDirectory: repo.dir,
    instructions: "Focus on the retry logic.",
    waitSeconds: 20,
  });
  check(
    "extra guidance reaches the reviewer for non-custom targets",
    /Focus on the retry logic/.test(guided.data.summary),
  );
});

console.log("");
console.log("cross-review (Codex reviews Codex, different model)");
await withServer("success", {}, async (call) => {
  const repo = makeRepo();
  const worked = await call("codex_delegate", {
    task: "Rewrite the parser",
    workingDirectory: repo.dir,
    scope: "only parser.js",
    model: "fake-large",
    waitSeconds: 20,
  });
  const reviewed = await call("codex_review", {
    taskId: worked.data.taskId,
    model: "fake-small",
    waitSeconds: 20,
  });
  check("the review runs", reviewed.data.status === "completed");
  check("a different model is used", reviewed.data.model === "fake-small");
  check("the review is linked to the task", reviewed.data.reviewOf?.taskId === worked.data.taskId);
  check(
    "the reviewer is told what the task was",
    /Rewrite the parser/.test(reviewed.data.summary),
    reviewed.data.summary,
  );
  check("and what scope applied", /only parser\.js/.test(reviewed.data.summary));
  check("and to flag scope violations", /outside that scope/i.test(reviewed.data.summary));

  const noTarget = await call("codex_review", {});
  check("review needs a directory or a task", noTarget.isError === true);

  const badTask = await call("codex_review", { taskId: "nope" });
  check("review rejects an unknown taskId", badTask.isError === true);

  const missingBranch = await call("codex_review", {
    workingDirectory: repo.dir,
    target: "baseBranch",
  });
  check("baseBranch without a branch is rejected", missingBranch.isError === true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
