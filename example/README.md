# Example backend

A zero-dependency logging server for trying AgentWatch Bridge locally. It accepts canonical
events on `/v1/events` and native agent OTLP on `/v1/otlp/v1/*`, and prints everything it
receives.

## Try it end to end

Terminal 1 — start the backend:

```bash
npm run build
npm run example          # http://127.0.0.1:8787
```

Terminal 2 — point the bridge at it:

```bash
node dist/cli.js setup --endpoint http://127.0.0.1:8787 --yes
# or, with a global install/npm link: agentwatch setup --endpoint http://127.0.0.1:8787 --yes
```

Then open a **new** Claude Code (or Codex) session in any repository and do something — ask it
to read a file or run a command. Terminal 1 will print `EVENT` lines for every hook event
(session start, prompts, tools, file edits) and `OTLP:*` lines once the agent flushes its native
telemetry (Claude exports metrics every ~60 s by default).

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
