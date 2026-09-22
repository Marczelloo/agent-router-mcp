# codex-router-mcp

[![CI](https://github.com/Marczelloo/agent-router-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Marczelloo/agent-router-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP server that puts guardrails around delegating work to OpenAI Codex.

Codex already ships its own MCP server (`codex mcp-server`), and it exposes two
tools: `codex` and `codex-reply`. If all you want is "run a Codex session from
another agent", use that — it is first-party and costs you nothing to maintain.

This project exists for what happens *around* the delegation:

- **No task can get stuck "running".** Every turn is supervised: a lost
  completion is recovered from the thread's real state, a turn blocked on an
  approval nobody can give is interrupted, and an interrupt Codex ignores is
  forced.
- **Quota is checked before a thread is started**, normalized by window duration,
  and an exhausted account returns a structured handoff instead of a failure.
- **Models are picked by policy** — fast, balanced or frontier — with reasoning
  effort capped per model.
- **Images can be generated**, so an agent that cannot draw can still ship a real
  raster asset, and look at it before using it.
- **Risky work runs in a dedicated git worktree**, so a bad turn cannot touch
  your working tree.
- **Every turn is bracketed by checkpoints**, so you can roll one back.
- **Reviews run read-only**, in both directions, optionally with a second model.
- **Changes are read from disk, not trusted from Codex.** Files Codex writes
  through the shell are reported; rejected writes are reported as failed.

```
Claude Code  ──MCP──▶  codex-router-mcp  ──JSON-RPC──▶  codex app-server
```

One persistent `codex app-server` child process serves every thread, so the
second delegation does not pay the startup cost again. Concurrent delegations
each get their own thread and never cross results.

## Requirements

- Node 20+
- The `codex` CLI on `PATH`, logged in (`codex login`) or configured with an API key.
  The `gpt-6-*` models need Codex CLI 0.155 or newer (`codex update`).

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

## Give the model a policy

Installing the tools gives the model the *ability* to delegate. It still needs a
policy for *when*. Put something like this in your global agent instructions —
without it the model sees twelve tools and no guidance:

> You are the tech lead. Codex is an external subagent; you decide what to
> delegate.
>
> - Delegate work that is self-contained, mechanical and narrowly scoped —
>   migrations, refactors that follow a pattern, filling in tests, boilerplate.
>   Do it yourself when it needs architectural judgement, context from the
>   conversation, or is small enough that delegating costs more than it saves.
> - Pick the model by difficulty: `luna` for mechanical work, `sol` (the default)
>   for everyday work, `astra` for the hardest problems. Check `codex_get_limits`
>   before anything large.
> - Use `isolation: "worktree"` for large, risky or experimental work, or when
>   there is uncommitted work that must not be lost.
> - `status: "running"` means Codex is still working. Wait with
>   `codex_task_status({ taskId, waitSeconds })`; never delegate the same task twice.
> - Always review what Codex produced — changed files, diff, then the code — and
>   check it stayed inside `scope`. Send corrections through `codex_continue`.
> - When you need a real image, use `codex_generate_image`, then look at the
>   preview before using it.
> - On `quota_exhausted`, read `remainingWork` and finish the task yourself.
>   Never wait for a quota reset and never retry in a loop.
> - If `failedFileChanges` is present, those files were **not** written. Do not
>   review them.

[CLAUDE.md](CLAUDE.md) is the full version this repository runs on (in Polish).

## Tools

| Tool | Purpose |
|---|---|
| `codex_get_models({ refresh? })` | Recommended models by tier, with the efforts the policy allows; read live. |
| `codex_get_limits()` | Quota windows normalized by duration, with a delegation verdict. |
| `codex_delegate({ task, workingDirectory, scope?, model?, reasoningEffort?, isolation?, branch?, waitSeconds?, timeoutSeconds? })` | Run a task in a fresh Codex thread. |
| `codex_continue({ taskId, instruction, ... })` | Follow-up instruction on an existing thread, context intact. |
| `codex_task_status({ taskId?, waitSeconds?, refresh? })` | Status and live progress; `waitSeconds` blocks until the task finishes. |
| `codex_interrupt(taskId)` | Stop the in-flight turn — guaranteed to leave `running`; the thread survives. |
| `codex_review({ workingDirectory?, taskId?, target?, ... })` | Read-only review of your work or of a Codex task. |
| `codex_generate_image({ prompt, outputPath?, count?, size?, referenceImages?, ... })` | Generate images; files on disk plus a preview. |
| `codex_checkpoints(taskId)` | List working-tree snapshots taken around turns. |
| `codex_restore({ taskId, checkpointId, removeUntracked? })` | Roll the working tree back. |
| `codex_worktree({ taskId, action, message?, force? })` | Commit or remove a task's isolated worktree. |
| `codex_server({ action? })` | App-server health and running tasks, or restart a wedged app-server. |

## Models

The catalogue is always read live from Codex. On top of it sits a small policy
that steers work towards three models and caps how hard each may think:

| Model | Alias | Tier | Reasoning | Use for |
|---|---|---|---|---|
| `gpt-6-luna` | `luna`, `fast` | fast | low → **xhigh** | Mechanical edits, boilerplate, pattern-following tests, image generation. Lowest quota use. |
| `gpt-6-sol` | `sol`, `balanced` | balanced | low → **high** | Everyday feature work, bug fixes with a known cause, most review. **The default.** |
| `gpt-6-astra` | `astra`, `frontier`, `best` | frontier | low → **high** | Hard debugging, algorithm design, cross-cutting changes, second opinions on critical code. Heaviest on quota. |

Every model defaults to `medium` effort. A request above a model's cap is
**clamped, not refused** — an over-eager effort is a cost decision, not an error,
and a refusal would waste a round trip — and the clamp is reported in `notes`.
A model outside the policy still runs if named explicitly, with a note steering
back. A policy model missing from the live catalogue is reported as unavailable
rather than assumed to exist.

Override the policy with `AGENT_ROUTER_MODEL_POLICY` (a JSON array of
`{ id, aliases, tier, maxEffort, defaultEffort, summary, useFor }`; only `id` is
required) and the default with `AGENT_ROUTER_DEFAULT_MODEL`.

## Keeping turns under control

A delegated turn can go wrong in more ways than "it failed": the completion
notification can be lost, Codex can block on an approval that a headless router
can never give, an interrupt can go unanswered, or the app-server can wedge.
None of these may leave a task in `running`.

- **One outcome, processed once.** A turn's result is handled by whoever settles
  it — Codex's completion, an error, a reconcile, the watchdog or an interrupt —
  never only by the caller that happened to be waiting. A turn that outlives
  `waitSeconds` still finishes and records its result.
- **Waiting instead of polling.** `codex_task_status({ taskId, waitSeconds })`
  blocks until the task finishes. Running results carry `progress`: `health`
  (`active`, `quiet`, `stalled`, `blocked`), running and idle seconds, deadline,
  current plan step, last message and last command.
- **Calls that fit the client.** Many MCP clients cancel a request after 60 s —
  it is the SDK default. Every blocking call therefore returns within 50 s by
  default, handing back `running` and a `taskId`; the task itself keeps going.
  While a call blocks, the server sends MCP progress notifications, which clients
  that honour them use to reset their timeout and show progress. If your client
  allows longer calls, raise `AGENT_ROUTER_DEFAULT_WAIT_SECONDS`.
- **Reconciliation.** When a thread goes quiet, or a status check finds it silent,
  the router reads the thread back with `thread/read` and settles any turn Codex
  says has ended. A dropped notification cannot wedge a task.
- **Watchdog.** Every few seconds it checks running turns: past its time limit
  (`timeoutSeconds`, default one hour) a turn is interrupted; blocked on an
  approval or user input for more than a minute, it is interrupted; silent for
  three minutes, it is re-read and flagged `stalled` — but silence alone never
  kills, because a long command can be quiet and still working.
- **Interrupts that always land.** `codex_interrupt` asks Codex first; if Codex
  does not confirm within ten seconds it checks the thread's real state, and
  failing that marks the turn interrupted itself, reported as `forced: true`.
  Late completions of a turn that was already settled are ignored, so they can
  never be mistaken for the next turn on the same thread.
- **Restart.** `codex_server({ action: "restart" })` replaces a wedged app-server.
  Turns in flight are reported interrupted; their threads survive on disk and
  `codex_continue` resumes them. On Windows the whole process tree is killed, so
  no orphaned `codex.exe` is left behind.

Every intervention — reconcile, stall, auto-interrupt, forced stop, restart — is
recorded on the task under `interventions`, with its reason.

## Image generation

`codex_generate_image` drives Codex's built-in image tool.

```
codex_generate_image({
  prompt: "A flat app icon: a white paper plane on a deep blue rounded square",
  outputPath: "assets/icon.png",
})
```

- The Codex thread runs **read-only**: generation happens server-side and the
  router writes the files itself, so images work even where the local sandbox
  cannot write.
- Files default to `<workingDirectory>/generated-images/<prompt-slug>.png`.
  `outputPath` may name a file or a directory; a `.jpg` path is transcoded rather
  than mislabelled. Existing files are **never overwritten** unless you pass
  `overwrite: true` — a numeric suffix is added and the real path returned.
- `count` (1–4), `size` and `transparentBackground` are passed to Codex as
  requirements. `size` is a hint, not a guarantee.
- `referenceImages` attaches local PNG/JPEG files for edits, variations or style.
- The result lists every image with its path, dimensions, size, the prompt Codex
  actually used, and how transparent it is. A downscaled JPEG **preview** is
  attached so the calling model can look at the result (`preview: "full"` for the
  original, `"none"` for paths only). Transparency is drawn over a checkerboard,
  so a translucent area reads as transparent rather than as a white shape.
- Codex sometimes returns an RGBA image whose alpha channel is largely
  translucent even when no transparency was asked for. That is reported as a
  `warning` — the file is left untouched, since there is no single correct way to
  flatten a broken alpha channel.
- Defaults to `gpt-6-luna` at `low` effort: the turn is a single tool call.
- Image generation has its own quota. When it runs out the result is
  `quota_exhausted` with the reset time — and, unlike a code task, it does not
  tell the caller to finish the job itself, since it cannot.

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
so the calling agent can continue from where Codex stopped. `usageLimitExceeded`,
`rateLimitExceeded` and `sessionBudgetExceeded` are all treated as quota.

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

## Honest change reporting

Codex only tracks edits made through its patch tool. A file it writes with a
shell command — which it does often — produces no change event, so Codex's own
list can come back empty while the files sit on disk. The router therefore takes
`changedFiles` and `diff` from the most truthful source available, and says
which one in `changeSource`:

- `worktree` — an isolated task, diffed against the commit its branch started from;
- `working-tree` — a task in a git repository, diffed between the snapshot taken
  before its first turn and the one after its last, so shell writes are included;
- `codex-reported` — outside git, only what Codex itself tracked. Shell writes
  may be missing here, and the result says so rather than guessing.

Files Codex reports that git cannot see (ignored paths) are merged in.

The opposite failure matters too: Codex can finish a turn cleanly while every
write it attempted was rejected — a misconfigured sandbox does exactly that. The
rejected patches are listed under `failedFileChanges`. In a git repository the
router can confirm nothing reached disk and says so, telling the caller not to
review files that were never written; a rejected patch whose file was written
anyway by a later command is not reported as a failure. Outside git it cannot
tell, and the `warning` asks the caller to check the files instead of claiming
either way.

### Known issue: the Codex sandbox on Windows

`AGENT_ROUTER_SANDBOX` defaults to `workspace-write`. On Windows that sandbox
needs a helper binary, `codex-windows-sandbox-setup.exe`, that some Codex
installations do not ship (still the case in 0.155.1). When it is missing every
write is silently rejected.

Reproduce it without this server:

```bash
codex sandbox cmd /c "echo hi > test.txt"
```

A healthy install writes the file; a broken one prints
`orchestrator_helper_launch_failed: ... program not found`. Note that
`windowsSandbox/readiness` still reports `ready`, so it does not catch this.

Repair the Codex installation if you can. `AGENT_ROUTER_SANDBOX=danger-full-access`
works around it but removes the sandbox entirely — pair it with
`isolation: "worktree"` at minimum. Image generation and review are unaffected:
both run read-only.

### Updating Codex on Windows

If `codex update` fails with `tar (child): Cannot connect to C: resolve failed`,
it was run from Git Bash, where `tar` is GNU tar and reads `C:\…` as a remote
host. If it fails with `Get-FileHash is not recognized`, it was run from
PowerShell 7, whose module path breaks the Windows PowerShell 5.1 installer it
spawns. Run it from PowerShell with the module path reset:

```powershell
Remove-Item Env:PSModulePath; codex update
```

## Configuration

All optional, set as environment variables on the MCP server entry.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_ROUTER_CODEX_BIN` | `codex` | Executable to spawn. |
| `AGENT_ROUTER_CODEX_ARGS` | `app-server` | Args; a JSON array is accepted for paths with spaces. |
| `AGENT_ROUTER_SANDBOX` | `workspace-write` | Sandbox for delegations (reviews and images are always read-only). |
| `AGENT_ROUTER_APPROVAL_POLICY` | `never` | Codex runs headless; nobody can answer prompts. |
| `AGENT_ROUTER_AUTO_APPROVE` | `false` | Accept an approval request that arrives anyway. |
| `AGENT_ROUTER_DEFAULT_MODEL` | `gpt-6-sol` | Model used when a caller names none. |
| `AGENT_ROUTER_MODEL_POLICY` | built in | JSON array replacing the model policy. |
| `AGENT_ROUTER_IMAGE_MODEL` | `gpt-6-luna` | Model for image generation. |
| `AGENT_ROUTER_IMAGE_EFFORT` | `low` | Reasoning effort for image generation. |
| `AGENT_ROUTER_IMAGE_PREVIEW_MAX_EDGE` | `768` | Long edge of the preview, in pixels. |
| `AGENT_ROUTER_ISOLATION` | `none` | Default isolation: `none` or `worktree`. |
| `AGENT_ROUTER_WORKTREE_ROOT` | `~/.agent-router/worktrees` | Where linked worktrees are created. |
| `AGENT_ROUTER_CHECKPOINTS` | on | Set to `off` to stop snapshotting around turns. |
| `AGENT_ROUTER_QUOTA_PREFLIGHT` | on | Set to `off` to skip the pre-delegation quota check. |
| `AGENT_ROUTER_QUOTA_LOW_PERCENT` | `15` | Remaining percent that triggers the `low` warning. |
| `AGENT_ROUTER_QUOTA_BLOCK_PERCENT` | `2` | Remaining percent that blocks delegation. |
| `AGENT_ROUTER_DEFAULT_WAIT_SECONDS` | `50` | Blocking window before returning `running`; kept under the common 60 s client timeout. |
| `AGENT_ROUTER_MAX_WAIT_SECONDS` | `1800` | Ceiling on `waitSeconds`. |
| `AGENT_ROUTER_PROGRESS_INTERVAL_SECONDS` | `10` | How often a blocking call sends an MCP progress notification. |
| `AGENT_ROUTER_TURN_TIMEOUT_SECONDS` | `3600` | Hard limit per turn; `0` disables it. |
| `AGENT_ROUTER_STALL_SECONDS` | `180` | Silence after which a turn is re-read and flagged `stalled`. |
| `AGENT_ROUTER_BLOCKED_TIMEOUT_SECONDS` | `60` | How long a turn may wait on an approval or input before it is interrupted. |
| `AGENT_ROUTER_WATCHDOG_INTERVAL_SECONDS` | `15` | How often the watchdog checks running turns. |
| `AGENT_ROUTER_INTERRUPT_GRACE_SECONDS` | `10` | How long an interrupt waits for Codex to confirm before forcing. |
| `AGENT_ROUTER_STATE_FILE` | `~/.agent-router/tasks.json` | Task metadata file, written atomically. |
| `AGENT_ROUTER_DEBUG` | `false` | Mirror app-server stderr and protocol traffic to stderr. |

## Tests

```bash
npm test
```

275 assertions. The real MCP server is booted over stdio but pointed at
`test/fake-app-server.mjs` instead of `codex app-server`, so the whole router —
JSON-RPC client, notification wiring, turn supervision, quota and model policy,
image handling, task store, git plumbing — is exercised **without a Codex account
and without spending quota**. The fake reproduces the failure modes that matter:
a completion that arrives after the caller stopped waiting, a completion that
never arrives, an interrupt that is ignored, a turn blocked on an approval, a
start reply that arrives after its turn was already settled and a newer one
begun, two image generations racing for one file name, a file written through
the shell that Codex never reports, and an image with a broken alpha channel. Git cases run against throwaway
repositories. This is what CI runs on Linux, macOS and Windows.

```bash
npm run smoke
```

Read-only check against the real `codex app-server`: prints the recommended
models, the Codex version and current limits. Starts no turn, so it spends no
quota.

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
