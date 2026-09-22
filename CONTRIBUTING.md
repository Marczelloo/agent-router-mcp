# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

`npm test` needs no Codex account and spends no quota: it boots the real MCP
server but points it at `test/fake-app-server.mjs`. Please keep it that way —
a test that needs a live Codex login is a test most contributors cannot run.

## Adding behaviour

Every behavioural change needs a case in `test/run-tests.mjs`. If the change
concerns how the router reacts to Codex, model that reaction in
`test/fake-app-server.mjs` as a new `FAKE_SCENARIO` rather than mocking inside
the router. The scenarios are listed at the top of that file.

Keep the fake faithful to real Codex behaviour, because the router's bookkeeping
depends on it: every `thread/start` and every turn gets a fresh id, `thread/read`
reports the thread's real status and turns, and `thread/status/changed` is sent
as turns start and end. A fake that reuses one turn id, for example, hides bugs
in stale-completion handling instead of catching them.

Turn supervision is the most delicate part of the router. Any change to how a
turn ends — completion, error, interrupt, reconcile, watchdog, app-server exit —
must keep one invariant: a turn's outcome is processed exactly once, and no task
can be left in `running`. The "lost completion", "unresponsive" and "blocked"
scenarios exist to hold that line.

`npm run smoke` is a read-only check against a real `codex app-server`. It
starts no turn, so it is safe to run, but it is not part of CI.

## Protocol changes

`src/protocol.ts` mirrors only the subset of the app-server protocol this
router reads, so that an unrelated Codex change cannot break the build. The
authoritative definitions come from Codex itself:

```bash
codex app-server generate-ts --out ./generated-ts
codex app-server generate-json-schema --out ./generated-schema
```

Do not vendor the generated files — copy across only what is used, with the
field comments that explain it.

## Style

Match the surrounding code. Comments explain *why*, not *what*: prefer one line
about the constraint that forced a decision over three restating the code.
