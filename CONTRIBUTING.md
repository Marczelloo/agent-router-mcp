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
the router.

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
