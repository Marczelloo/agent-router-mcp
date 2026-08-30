# codex-router-mcp

An MCP server that puts guardrails around delegating work to OpenAI Codex.

Codex already ships its own MCP server (`codex mcp-server`), and it exposes two
tools: `codex` and `codex-reply`. If all you want is "run a Codex session from
another agent", use that — it is first-party and costs you nothing to maintain.

This project exists for what happens *around* the delegation:

- **Quota is checked before a thread is started**, normalized by window duration,
  and an exhausted account returns a structured handoff instead of a failure.
- **Risky work runs in a dedicated git worktree**, so a bad turn cannot touch
  your working tree.
- **Every turn is bracketed by checkpoints**, so you can roll one back.
- **Reviews run read-only**, in both directions, optionally with a second model.
- **Failed writes are reported as failed**, never as changes.

```
Claude Code  ──MCP──▶  codex-router-mcp  ──JSON-RPC──▶  codex app-server
```

One persistent `codex app-server` child process serves every thread, so the
second delegation does not pay the startup cost again. Concurrent delegations
each get their own thread and never cross results.

## Requirements

- Node 20+
- The `codex` CLI on `PATH`, logged in (`codex login`) or configured with an API key

## Install

```bash
claude mcp add codex-router -s user -- npx -y codex-router-mcp
```

Or from a clone:

```bash
npm install && npm run build
claude mcp add codex-router -s user -- node "/absolute/path/to/dist/index.js"
```

`-s user` makes it available in every project. A relative path only resolves
from the directory the client was started in, so use an absolute one.

To give the model a policy for *when* to delegate — not just the ability to —
copy the rules from [CLAUDE.md](CLAUDE.md) into your global agent instructions.
Without them the model sees ten tools and no guidance.

## Tools

| Tool | Purpose |
|---|---|
| `codex_get_models({ refresh? })` | Available models and the reasoning efforts each supports, read live. |
| `codex_get_limits()` | Quota windows normalized by duration, with a delegation verdict. |
| `codex_delegate({ task, workingDirectory, scope?, model?, reasoningEffort?, isolation?, branch?, waitSeconds? })` | Run a task in a fresh Codex thread. |
| `codex_continue({ taskId, instruction, ... })` | Follow-up instruction on an existing thread, context intact. |
| `codex_task_status(taskId?)` | Status, changed files, commands, plan, diff, worktree, checkpoints. |
| `codex_interrupt(taskId)` | Stop the in-flight turn; the thread survives. |
| `codex_review({ workingDirectory?, taskId?, target?, ... })` | Read-only review of your work or of a Codex task. |
| `codex_checkpoints(taskId)` | List working-tree snapshots taken around turns. |
| `codex_restore({ taskId, checkpointId, removeUntracked? })` | Roll the working tree back. |
| `codex_worktree({ taskId, action, message?, force? })` | Commit or remove a task's isolated worktree. |

## Quota

Limits are normalized **by window duration, not by slot name**:

| `windowDurationMins` | label |
|---|---|
| 60 | `1h` |
| 300 | `5h` |
| 1440 | `daily` |
| 10080 | `weekly` |
| 43200 | `monthly` |
| other | derived (`3h`, `2w`, `90min`, …) |

`primary` is *not* assumed to be the 5h window — the API is free to put the
weekly window there. Per window you get `usedPercent`, `remainingPercent`,
`resetsAt` (ISO + epoch), `resetsInMinutes` and `rateLimitReached`, plus
`tightest` (the window that actually gates the next turn) and a verdict:
`ok`, `low` (delegate, with a warning attached) or `exhausted`.

### The handoff

When quota runs out — at preflight or mid-turn — you get this instead of a
failure:

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
  "nextStep": "Do NOT wait for the quota to reset ... finish it yourself."
}
```

The router never retries and never waits for a reset. Partial work is reported
so the calling agent can continue from where Codex stopped.

A non-quota failure returns `status: "failed"` instead — the two are kept
distinct so a compile error is not mistaken for a billing problem.

## Isolation: git worktrees

`isolation: "worktree"` creates a linked worktree on a dedicated branch
(`agent-router/<taskId>` unless you pass `branch`) and points Codex at it. Your
working tree is never touched, whatever the turn does.

Worktrees are created under `~/.agent-router/worktrees/` — outside the
repository, so they never appear in `git status`. If `workingDirectory` was a
subdirectory of the repo, Codex is placed in the matching subdirectory.

For an isolated task, `changedFiles` and `diff` are computed against the commit
the branch started from, so they show the cumulative result across every turn.

Integration is deliberately manual:

```
codex_worktree({ taskId, action: "commit" })   # work lands on the task branch
git merge agent-router/<taskId>                # you run this, not the router
codex_worktree({ taskId, action: "remove" })   # clean up
```

The router never writes to your branch.

## Checkpoints

Inside a git repository, the working tree is snapshotted before and after every
turn, capturing **tracked and untracked files** while respecting `.gitignore`.

The snapshot is built through a throwaway `GIT_INDEX_FILE`, so it never disturbs
what you have staged. `git stash create` is the obvious primitive but it silently
omits untracked files — exactly what a delegated agent tends to produce.

```
codex_checkpoints(taskId)
codex_restore({ taskId, checkpointId: "cp-1" })
```

`codex_restore` rewrites file contents with `git restore --worktree`, leaving the
index alone. Files created *after* the checkpoint are reported as
`leftoverFiles` and only deleted when `removeUntracked: true` is passed. Every
restore first captures the current state and returns it as `safetyCheckpoint`,
so **a restore is itself undoable**.

Checkpoints are dangling commits, not refs. They survive normal use and git's
default garbage collection, but an explicit `git gc --prune=now` discards them.

## Review

`codex_review` uses Codex's native `review/start` with inline delivery and a
**read-only sandbox** — the reviewer cannot edit what it reviews.

- Pass `workingDirectory` to have Codex review *your* uncommitted work.
- Pass `taskId` (optionally with a different `model`) to have Codex review a
  previous Codex task. The reviewer is given the original task and its `scope`,
  so it also flags work that went out of bounds.

`target` selects what to review: `uncommittedChanges` (default), `baseBranch`,
`commit`, or `custom`.

## Honest failure reporting

Codex can finish a turn cleanly while every write it attempted was rejected — a
misconfigured sandbox does exactly that. In that case `changedFiles` stays empty,
the rejected patches are listed under `failedFileChanges`, and a `warning` tells
the caller not to review files that were never written.

### Known issue: the Codex sandbox on Windows

`AGENT_ROUTER_SANDBOX` defaults to `workspace-write`. On Windows that sandbox
needs a helper binary, `codex-windows-sandbox-setup.exe`, that some Codex
installations do not ship. When it is missing every write is silently rejected.

Reproduce it without this server:

```bash
codex sandbox cmd /c "echo hi > test.txt"
```

A healthy install writes the file; a broken one prints
`orchestrator_helper_launch_failed: ... program not found`. Note that
`windowsSandbox/readiness` still reports `ready`, so it does not catch this.

Repair the Codex installation if you can. `AGENT_ROUTER_SANDBOX=danger-full-access`
works around it but removes the sandbox entirely — pair it with
`isolation: "worktree"` at minimum.

## Configuration

All optional, set as environment variables on the MCP server entry.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_ROUTER_CODEX_BIN` | `codex` | Executable to spawn. |
| `AGENT_ROUTER_CODEX_ARGS` | `app-server` | Args; a JSON array is accepted for paths with spaces. |
| `AGENT_ROUTER_SANDBOX` | `workspace-write` | Sandbox for delegations (reviews are always read-only). |
| `AGENT_ROUTER_APPROVAL_POLICY` | `never` | Codex runs headless; nobody can answer prompts. |
| `AGENT_ROUTER_AUTO_APPROVE` | `false` | Accept an approval request that arrives anyway. |
| `AGENT_ROUTER_ISOLATION` | `none` | Default isolation: `none` or `worktree`. |
| `AGENT_ROUTER_WORKTREE_ROOT` | `~/.agent-router/worktrees` | Where linked worktrees are created. |
| `AGENT_ROUTER_CHECKPOINTS` | on | Set to `off` to stop snapshotting around turns. |
| `AGENT_ROUTER_QUOTA_PREFLIGHT` | on | Set to `off` to skip the pre-delegation quota check. |
| `AGENT_ROUTER_QUOTA_LOW_PERCENT` | `15` | Remaining percent that triggers the `low` warning. |
| `AGENT_ROUTER_QUOTA_BLOCK_PERCENT` | `2` | Remaining percent that blocks delegation. |
| `AGENT_ROUTER_DEFAULT_WAIT_SECONDS` | `240` | Blocking window before returning `running`. |
| `AGENT_ROUTER_MAX_WAIT_SECONDS` | `1800` | Ceiling on `waitSeconds`. |
| `AGENT_ROUTER_STATE_FILE` | `~/.agent-router/tasks.json` | Task metadata file. |
| `AGENT_ROUTER_DEBUG` | `false` | Mirror app-server stderr and protocol traffic to stderr. |

A task that outlives `waitSeconds` returns `status: "running"` with a `taskId` to
poll, so an MCP call never blocks forever.

## Tests

```bash
npm test
```

143 assertions. The real MCP server is booted over stdio but pointed at
`test/fake-app-server.mjs` instead of `codex app-server`, so the whole router —
JSON-RPC client, notification wiring, quota policy, task store, git plumbing — is
exercised **without a Codex account and without spending quota**. Git cases run
against throwaway repositories. This is what CI runs on Linux, macOS and Windows.

```bash
npm run smoke
```

Read-only check against the real `codex app-server`: prints the live model
catalogue and current limits. Starts no turn, so it spends no quota.

## Stability and terms

This server talks to `codex app-server`, which the Codex CLI marks
`[experimental]`. Its protocol has no public documentation or stability
guarantee; the type definitions in `src/protocol.ts` mirror only the subset used
here and were derived from `codex app-server generate-ts`. A Codex release can
change it. Regenerate and re-check if something breaks:

```bash
codex app-server generate-ts --out ./generated-ts
```

On terms: this server does not fork Codex, does not touch authentication, and
does not reimplement any OpenAI client. It spawns the official `codex` binary
you installed and logged into yourself. OpenAI has stated that the Codex CLI is
Apache-2.0 and that forking is permitted, but has
[not clarified](https://github.com/openai/codex/discussions/8338) whether
third-party tools driving a ChatGPT-plan session are covered by the Terms of
Use, and their docs recommend API keys for automation. If you are automating
heavily, or building anything commercial on this, use an API key and take your
own legal advice.

## License

MIT — see [LICENSE](LICENSE).
