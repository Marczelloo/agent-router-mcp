# Agent Router

This repository contains one deliverable: Agent Router, an MCP server that lets
Claude Code delegate coding tasks to OpenAI Codex as an external subagent.
Claude remains the tech lead: it selects the Codex model and reasoning effort,
checks quota before delegating, can isolate risky work in a git worktree, can
restore checkpoints, and can request a read-only code review or take over when
Codex runs out of quota. The flow is:

```
Claude Code  ──MCP──▶  agent-router  ──JSON-RPC──▶  codex app-server
```

## Repository layout

- `tools/agent-router/` — the MCP server and its detailed documentation.
- `CLAUDE.md` — Claude's operating policy for using the router in this repository.
- `tools/agent-router/src/` — the TypeScript implementation, including the
  app-server protocol definitions used by the router.
- `tools/agent-router/test/` — the test runner, fake app-server, and live smoke
  check.

## Quick start

From the repository root:

```bash
cd tools/agent-router
npm install
npm run build
```

Register the server with Claude Code (use an absolute path):

```bash
claude mcp add agent-router -s user -e AGENT_ROUTER_SANDBOX=workspace-write -- node "/absolute/path/to/tools/agent-router/dist/index.js"
```

## MCP tools

- `codex_get_models({ refresh? })` — list available models and reasoning levels.
- `codex_get_limits()` — report quota windows and delegation status.
- `codex_delegate({ ... })` — start a new Codex task.
- `codex_continue({ taskId, instruction, ... })` — continue an existing task.
- `codex_task_status(taskId?)` — inspect one task or list all tasks.
- `codex_interrupt(taskId)` — interrupt an in-flight turn.
- `codex_review({ ... })` — request a read-only Codex review.
- `codex_checkpoints(taskId)` — list task checkpoints.
- `codex_restore({ taskId, checkpointId, ... })` — restore a checkpoint.
- `codex_worktree({ taskId, action, ... })` — commit or remove an isolated worktree.

## Requirements

Node 22+, the `codex` CLI on `PATH`, and a logged-in Codex account (`codex login`).

See [tools/agent-router/README.md](tools/agent-router/README.md) for full
technical documentation, and [CLAUDE.md](CLAUDE.md) for Claude's operating
policy.
