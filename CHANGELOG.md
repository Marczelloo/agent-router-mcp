# Changelog

## Unreleased

### Added

- **Public status file.** Every state write now also writes
  `~/.agent-router/status.json` (next to the state file; override with
  `AGENT_ROUTER_STATUS_FILE`), a small versioned snapshot for other tools such
  as Agent Pets: running tasks plus those finished in the last 2 hours, at most
  50. It carries only a short title per task, no task text, diffs, commands or
  messages, plus `lastActivityAt`, `blocked` and `stallSeconds` so a reader can
  work out a task's health itself. A failed write is logged and never affects
  the router's own state.

## 0.3.0

Hardening from a product-readiness audit. Every fix below has a regression test
that fails without it.

### Fixed

- **`codex_restore` could delete user files.** A file created and staged after
  a checkpoint was removed by a restore even without `removeUntracked`, and was
  reported as a leftover. Restores now use overlay mode and delete nothing
  unless asked.
- **A restore from a pruned checkpoint wiped the working tree.** A checkpoint
  commit collected by `git gc` read as an empty snapshot; with
  `removeUntracked: true` every file was deleted and the restore reported
  success. The commit is now verified first, and the restore refuses otherwise.
- **Tracked files matching `.gitignore` were missing from checkpoints**, so a
  restore dropped them. Snapshots now start from a copy of the real index.
- **A restore went ahead when its safety checkpoint failed**, which broke the
  promise that a restore is undoable. It is now refused.
- **Non-ASCII file names** (`zażółć.txt`) were reported in git's quoted octal
  form. All path listings now use NUL-delimited output.
- **The router outlived its client.** Closing stdin — how MCP clients end a
  stdio server — left the process and its app-server running. It now shuts down.
- **Concurrent first calls raced the handshake.** A second tool call on a cold
  router could reach the app-server before `initialize` completed.
- **A failed handshake left a half-open app-server** that every later call
  talked to. It is now discarded, and the next call starts a fresh one.
- **Several Claude Code sessions overwrote each other's tasks** in the shared
  state file, and could hand out the same task id. Each router now writes back
  only its own tasks, ids are unique across processes, and a session can look
  up a task another session started.
- A pipe error on the app-server's streams, or a malformed message from it,
  could crash the whole MCP server.

### Changed

- **Leaner results.** `running` results no longer repeat the request, the
  command history or a quota snapshot. Finished results carry a compact
  `limits` with each window once (`codex_get_limits` is unchanged). Summaries,
  commands and `changedFiles` are capped, with the truncation stated.
- **Configuration is validated at startup.** An unknown isolation, sandbox or
  approval value, or an out-of-range number, stops the server with an error
  naming the variable instead of being cast through.
- Task history is bounded: finished tasks are kept for 30 days (at most 200),
  and per-task message, command and diff history is capped.
- Git commands time out after two minutes instead of blocking forever.
- Worktree status takes one snapshot instead of two.
- The version is read from `package.json` instead of being repeated in code.

## 0.2.0

- Turn supervision: every turn's outcome is processed exactly once, with
  reconcile via `thread/read`, a watchdog (deadline, blocked, stall), forced
  interrupts and `codex_server` restart.
- Image generation through `codex_generate_image`, with previews.
- Model policy for `gpt-6-luna`, `gpt-6-sol` and `gpt-6-astra`, with effort caps.
- Change reporting from git snapshots, including files written by shell commands.

## 0.1.0

- First release: delegation, continuation, quota-normalized limits and handoff,
  worktree isolation, checkpoints and cross-review.
