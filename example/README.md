# Example backend

A zero-dependency logging server for trying AgentWatch Bridge locally. It accepts
`turn.summary` on `/v1/events` and native agent OTLP on `/v1/otlp/v1/*`. A production receiver
must normalize completed requests to `llm.call` and durably upsert before acknowledging OTLP.

## Try it end to end

Terminal 1 — start the backend:

```bash
npm run build
npm run example          # http://127.0.0.1:8787
# JSON=1 npm run example — also print each event as full JSON
```

Terminal 2 — point the bridge at it:

```bash
node dist/cli.js setup --endpoint http://127.0.0.1:8787 --yes
# or, with a global install/npm link: agentwatch setup --endpoint http://127.0.0.1:8787 --yes
```

Then open a **new** Claude Code (or Codex) session in any repository and do something — ask it
to read a file or run a command. Terminal 1 prints one `TURN.SUMMARY` for each completed turn,
one normalized `LLM.CALL` for each completed provider request, and `OTLP:*` diagnostics for the
native log/trace batches. Hook lifecycle events are internal and are not product records.

For Codex, remember the one-time trust step: run `codex`, type `/hooks`, trust the AgentWatch
entries.

Check bridge health anytime:

```bash
node dist/cli.js status
node dist/cli.js doctor
```

Cleanup when done:

```bash
node dist/cli.js uninstall            # removes hooks + OTel config (add --purge for local data)
```
