# Agent Router MCP

An MCP server that turns **Codex into a subagent for Claude Code**. Claude stays
the tech lead: it picks the model, picks the reasoning effort, watches the quota,
isolates risky work, reviews the result — and takes the task over itself when
Codex runs out of quota.

```
Claude Code  ──MCP──▶  agent-router  ──JSON-RPC──▶  codex app-server
```

One persistent `codex app-server` child process serves every thread, so the
second delegation does not pay the startup cost again.

## Setup

```bash
cd tools/agent-router
npm install
npm run build
```

Requires the `codex` CLI on `PATH` and a logged-in Codex account (`codex login`).

Register the server with Claude Code. User scope makes it available in every
project (note the absolute path — a relative one only resolves from the directory
Claude Code was started in):

```bash
claude mcp add agent-router -s user -e AGENT_ROUTER_SANDBOX=workspace-write -- node "/absolute/path/to/tools/agent-router/dist/index.js"
```

For a single repository, commit a `.mcp.json` at its root instead:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "node",
      "args": ["tools/agent-router/dist/index.js"],
      "env": {}
    }
  }
}
```

Use one or the other. Defining the same server name in both scopes makes
`claude mcp list` report a scope conflict.

To make the tech-lead policy travel with the server, put the rules from this
repo's [CLAUDE.md](../../CLAUDE.md) into `~/.claude/CLAUDE.md` — without them the
model sees ten tools and no policy for when to reach for them.

## Tools

### `codex_get_models({ refresh? })`

Every model the account can use, each with the reasoning-effort levels it
actually supports, read live from `model/list`. Nothing is hardcoded — a new
Codex model shows up here the day it ships.

### `codex_get_limits()`

Usage limits normalized **by window duration, not by slot name**:

| `windowDurationMins` | label |
|---|---|
| 60 | `1h` |
| 300 | `5h` |
| 1440 | `daily` |
| 10080 | `weekly` |
| 43200 | `monthly` |
| other | derived (`3h`, `2w`, `90min`, …) |

`primary` is *not* assumed to be the 5h window — the API is free to put the
weekly window there, and the labels follow the declared duration either way.

Per window you get `usedPercent`, `remainingPercent`, `resetsAt` (ISO + epoch),
`resetsInMinutes` and `rateLimitReached`, plus `tightest` (the window with the
least headroom, i.e. the one that actually gates a turn) and a `quota` verdict:

- `ok` — delegate freely,
- `low` — delegate, but the response carries a `warning`,
- `exhausted` — `canDelegate: false`.

### `codex_delegate({ task, workingDirectory, scope?, model?, reasoningEffort?, isolation?, branch?, waitSeconds? })`

Starts a fresh Codex thread and runs the task. Returns the outcome with
`summary`, `changedFiles`, `commands`, `plan`, `diff` and the task metadata.

Quota is checked **before** a thread is started, so an exhausted account costs
one cheap API call rather than a doomed turn.

If the task outlives `waitSeconds` (default 240s), the call returns
`status: "running"` with a `taskId` to poll — an MCP call never blocks forever.

`isolation: "worktree"` runs Codex in a dedicated git worktree (see below).

### `codex_continue({ taskId, instruction, ... })`

Resumes the existing Codex thread with all of its context, so review feedback
does not have to re-explain the task. Model and reasoning effort can be changed
mid-thread.

### `codex_task_status(taskId?)`

Full task record — including worktree and checkpoints; omit `taskId` to list
every task the router knows about.

### `codex_interrupt(taskId)`

Interrupts the in-flight turn. The thread survives and `codex_continue` can pick
it back up.

### `codex_review({ workingDirectory?, taskId?, target?, branch?, commit?, instructions?, model?, reasoningEffort? })`

Cross-review, in both directions. Uses Codex's native `review/start` with inline
delivery and a **read-only sandbox** — the reviewer cannot edit what it reviews.

- **Codex reviews Claude** — pass `workingDirectory` to get a second opinion on
  your own uncommitted work before you ship it.
- **Codex reviews Codex** — pass `taskId` (optionally with a different `model`)
  for a genuine cross-model second opinion. The reviewer is told the original
  task and its `scope`, so it also flags work that went out of bounds.

`target` selects what to review: `uncommittedChanges` (default), `baseBranch`
(with `branch`), `commit` (with `commit`), or `custom` (with `instructions`).
For the non-custom targets, `instructions` becomes extra guidance for the
reviewer. The result is a review task, so it can be polled or extended with
`codex_continue` like any other.

### `codex_checkpoints(taskId)` and `codex_restore({ taskId, checkpointId, removeUntracked? })`

See *Checkpoints* below.

### `codex_worktree({ taskId, action, message?, force? })`

`commit` records the worktree's work on the task branch and hands back the merge
command. `remove` tears the worktree down, refusing to discard uncommitted work
unless `force: true`.

## Isolation: git worktrees

`isolation: "worktree"` creates a linked worktree on a dedicated branch
(`agent-router/<taskId>` unless you pass `branch`) and points Codex at it. The
user's working tree is never touched, whatever the turn does.

Worktrees are created under `~/.agent-router/worktrees/` — outside the
repository, so they never show up in `git status`. If `workingDirectory` was a
subdirectory of the repo, Codex is placed in the matching subdirectory of the
worktree.

For an isolated task, `changedFiles` and `diff` are computed against the commit
the branch started from, so they show the **cumulative** result across every
turn rather than only the last one.

Integration is deliberately manual:

```
codex_worktree({ taskId, action: "commit" })   # work lands on the task branch
git merge agent-router/<taskId>                # you run this, not the router
codex_worktree({ taskId, action: "remove" })   # clean up
```

The router never writes to the user's branch.

## Checkpoints

When the working directory is inside a git repository, the router snapshots the
working tree before and after every turn. Each checkpoint records **tracked and
untracked files** (respecting `.gitignore`) as a dangling commit.

The snapshot is built through a throwaway `GIT_INDEX_FILE`, so it never disturbs
whatever the user has staged. `git stash create` would be the obvious primitive
but it silently omits untracked files — exactly what a delegated agent tends to
produce.

```
codex_checkpoints(taskId)
codex_restore({ taskId, checkpointId: "cp-1" })
```

`codex_restore` rewrites file contents with `git restore --worktree`, leaving the
index alone. Files created *after* the checkpoint are reported as `leftoverFiles`
and only deleted when `removeUntracked: true` is passed.

Every restore first captures the current state as a new checkpoint and returns it
as `safetyCheckpoint`, so **a restore is itself undoable**.

One caveat: checkpoints are dangling commits, not refs. They survive normal use
and git's default garbage collection, but an explicit `git gc --prune=now` in the
repository would discard them. Commit anything you truly need to keep.

## Known issue: the Codex sandbox on Windows

Codex delegations run under `AGENT_ROUTER_SANDBOX`, which defaults to
`workspace-write`. On Windows that sandbox needs a helper binary,
`codex-windows-sandbox-setup.exe`, that some Codex installations do not ship.
When it is missing, **every write Codex attempts is silently rejected** while the
turn itself still completes.

Reproduce it without this router:

```bash
codex sandbox cmd /c "echo hi > test.txt"
```

A healthy install writes the file. A broken one prints
`orchestrator_helper_launch_failed: ... program not found`, and
`windowsSandbox/readiness` still reports `ready` — the readiness check does not
catch it.

The router does not paper over this: a turn where patches were rejected reports
them under `failedFileChanges`, keeps `changedFiles` empty, and returns a
`warning` telling the tech lead not to review files that were never written.

Workarounds, in order of preference:

1. Repair or reinstall Codex so the sandbox helper is present.
2. Set `AGENT_ROUTER_SANDBOX=danger-full-access` in `.mcp.json`. This removes the
   sandbox entirely, so only do it if you are comfortable letting Codex write
   anywhere the user can — pairing it with `isolation: "worktree"` at least keeps
   the work off the user's branch.

## The quota handoff

When Codex runs out of quota — at preflight or mid-turn — the response is:

```json
{
  "status": "quota_exhausted",
  "taskId": "codex-20260829173437-001",
  "originalTask": "...",
  "threadId": "01a04e96-7474-79a1-a173-8c3cc2919eeb",
  "changedFiles": ["src/a.ts (update)"],
  "summary": "Codex ran out of quota mid-task. ...",
  "remainingWork": "Unfinished plan steps reported by Codex: ...",
  "limits": { "windows": [ ... ] },
  "nextStep": "Do NOT wait for the quota to reset ... Take the task over and finish it yourself."
}
```

The router **never retries and never waits for a reset**. Partial work is
reported so Claude can continue from where Codex stopped rather than restart.

A non-quota failure returns `status: "failed"` instead — the two are kept
distinct so Claude does not treat a compile error as a billing problem.

## Task metadata

Every task keeps `taskId`, `kind`, Codex `threadId`, `model`, `reasoningEffort`,
`originalTask`, `scope`, `workingDirectory`, `requestedDirectory`, `isolation`,
`worktree`, `checkpoints`, `status`, per-turn history and timestamps. State is
mirrored to `~/.agent-router/tasks.json` on a best-effort basis; a task that was
in flight when the router died comes back as `interrupted` rather than eternally
`running`.

## Configuration

All optional, via environment variables in `.mcp.json`:

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_ROUTER_CODEX_BIN` | `codex` | Executable to spawn. |
| `AGENT_ROUTER_CODEX_ARGS` | `app-server` | Args; a JSON array is accepted for paths containing spaces. |
| `AGENT_ROUTER_SANDBOX` | `workspace-write` | Codex sandbox mode for delegations (reviews are always read-only). |
| `AGENT_ROUTER_APPROVAL_POLICY` | `never` | Codex runs headless; nobody can answer prompts. |
| `AGENT_ROUTER_AUTO_APPROVE` | `false` | Whether to accept an approval request that arrives anyway. |
| `AGENT_ROUTER_ISOLATION` | `none` | Default isolation: `none` or `worktree`. |
| `AGENT_ROUTER_WORKTREE_ROOT` | `~/.agent-router/worktrees` | Where linked worktrees are created. |
| `AGENT_ROUTER_CHECKPOINTS` | on | Set to `off` to stop snapshotting around turns. |
| `AGENT_ROUTER_QUOTA_PREFLIGHT` | on | Set to `off` to skip the pre-delegation quota check. |
| `AGENT_ROUTER_QUOTA_LOW_PERCENT` | `15` | Remaining percent that triggers the `low` warning. |
| `AGENT_ROUTER_QUOTA_BLOCK_PERCENT` | `2` | Remaining percent that blocks delegation. |
| `AGENT_ROUTER_DEFAULT_WAIT_SECONDS` | `240` | Default blocking window before returning `running`. |
| `AGENT_ROUTER_MAX_WAIT_SECONDS` | `1800` | Ceiling on `waitSeconds`. |
| `AGENT_ROUTER_STATE_FILE` | `~/.agent-router/tasks.json` | Task metadata file. |
| `AGENT_ROUTER_DEBUG` | `false` | Mirror app-server stderr and protocol traffic to stderr. |

## Tests

```bash
npm test
```

132 assertions. Boots the real MCP server but points it at
`test/fake-app-server.mjs` instead of `codex app-server`, so the whole router —
JSON-RPC client, notification wiring, quota policy, task store, git plumbing — is
exercised without spending Codex quota. The git tests run against throwaway
repositories created per case.

Covered: the happy path, thread continuation, quota preflight, the low-quota
warning, the mid-turn quota handoff, non-quota failures, long-running turns with
interrupt, input validation, checkpoint capture and restore (including undoing a
restore and leaving `.gitignore`d files alone), worktree isolation and teardown,
and review in all its target modes.

```bash
npm run smoke
```

Read-only check against the **real** `codex app-server`: prints the live model
catalogue and the current limits. Starts no turn, so it spends no quota — use it
to verify the install and the Codex login.

## Regenerating protocol types

[`src/protocol.ts`](src/protocol.ts) mirrors only the parts of the app-server
protocol this router reads. The authoritative definitions come from Codex itself:

```bash
codex app-server generate-ts --out ./generated-ts
```
