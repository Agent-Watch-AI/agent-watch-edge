# Deploying AgentWatch Edge through an MDM

Templates for pushing the Edge to a fleet, and — more importantly — a straight
answer about what each surface can and cannot enforce.

Two things travel separately, and keeping them separate is the whole point:

- **The binary**, which the MDM installs as root.
- **The policy**, which the coding agent reads on its own and which decides
  whether a developer can undo the install.

Only Claude Code currently has a managed policy file. For every other agent the
hooks live in a user-writable file, which means a developer can remove them —
see [What an admin cannot lock](#what-an-admin-cannot-lock).

## What is here

| Path | What it is |
| --- | --- |
| `claude-code/managed-settings.d/agentwatch.json` | A managed policy fragment carrying the AgentWatch hook and telemetry env block. A non-admin cannot override it. |
| `jamf/deploy-agentwatch.sh` | Jamf/Kandji/Mosyle script policy: install as root, enroll as the console user. |
| `intune/Deploy-AgentWatch.ps1` | The Windows equivalent, as an Intune platform script. |

Each script is deliberately small and does the same three things: install, run
`agentwatch setup` **as the logged-in user**, and verify with
`agentwatch doctor --json`. Enrollment is per-user because the Edge writes into
the developer's own agent config and attributes turns to their identity; a setup
run as root would configure root's agents and no one else's.

## Before you roll out

Decide these first — the templates carry a placeholder for each:

- The **backend base URL**, passed as `--endpoint`.
- The **enrollment token**. Deliver it through your MDM's secret mechanism, not
  by editing it into a script you commit. On Jamf that is script parameter `$5`.
  Intune platform scripts take no arguments at all — they run as
  `powershell.exe -ExecutionPolicy Bypass -File <script>` with no console — so
  the Windows template reads `AGENTWATCH_ENDPOINT` and `AGENTWATCH_TOKEN` from
  the machine environment, which a configuration profile or a wrapping Win32 app
  sets first. Both templates then hand the token to setup through
  `AGENTWATCH_TOKEN` rather than `--token`: a command line shows up in `ps` for
  any user on the machine and in shell history, while an environment is readable
  only by the process owner and root. Better, not secret — the token is a
  credential on a machine its user administers either way. The flag still exists
  and still wins, for the interactive case where none of this matters.
- **Content capture.** It is off unless the global config carries
  `contentCaptureConsent: true` *and* the individual flags. Nothing in these
  templates turns it on, and a repository `.agentwatch.json` cannot. If your
  organization has decided to collect prompt or response text, that is a
  deliberate edit to `~/.agentwatch/config.json` — see
  [docs/DATA_HANDLING.md](../../docs/DATA_HANDLING.md).

## What an admin cannot lock

Print this next to the rollout plan rather than letting someone discover it.

| Agent | Managed policy file | A developer can remove the hooks |
| --- | --- | --- |
| Claude Code | ✅ `managed-settings.json` (see below) | No, if you deploy the managed file |
| OpenAI Codex | ❌ user-scoped `~/.codex/hooks.json` | Yes |
| Cursor | ❌ user-scoped `~/.cursor/hooks.json` | Yes |
| Gemini CLI | ❌ user-scoped `~/.gemini/settings.json` | Yes |
| Antigravity | ❌ user-scoped hooks file | Yes |

Two further limits, both real:

- **Even the managed file has a floor.** A developer who is a local
  administrator on their own machine can edit the managed source itself.
  Anthropic states this about their own file and so do we: the managed path
  raises the cost of removal, it does not make removal impossible.
- **Codex needs one manual step per machine.** After the hooks are written, the
  developer must run `codex`, then `/hooks`, and trust the AgentWatch entries.
  There is no way to script that approval from our side. Budget for it in the
  rollout note you send developers, or Codex turns will silently go unreported.

Our tamper stance follows from that: the Edge does not self-protect and does not
re-apply itself on a schedule. A machine that stops reporting is the signal, and
it is visible on the platform side. If that is not enough for your deployment,
the Claude Code managed path is the only one that currently does better.

## Claude Code managed settings

**Drop it in `managed-settings.d/`, not on top of `managed-settings.json`.**
Claude Code reads an optional `managed-settings.d/` directory next to the main
file, which exists for exactly this — one team owning one part of a policy.
Writing `managed-settings.json` directly would overwrite whatever policy your
organization already has there.

The system directory is:

- macOS — `/Library/Application Support/ClaudeCode/`
- Linux and WSL — `/etc/claude-code/`
- Windows — `C:\Program Files\ClaudeCode\`. Not `C:\ProgramData\ClaudeCode\`:
  Claude Code does not read that legacy path.

A file-based policy is read at startup and reloaded when the file changes, so a
developer who edits their own `~/.claude/settings.json` gets the managed values
back without a reinstall. (The half-hourly re-check applies to the macOS
configuration profile and the Windows `HKLM` value, not to this file.) If you
deliver policy that way instead, the keys are identical and only the container
changes; Anthropic publishes Jamf, Iru, Intune and Group Policy starter
templates at <https://github.com/anthropics/claude-code/tree/main/examples/mdm>.

Four things to know before you copy it:

- **If your organization sets `allowManagedHooksOnly`, this file is not
  optional.** That setting restricts which hooks run, so the hooks
  `agentwatch setup` writes into `~/.claude/settings.json` stop firing and only
  managed ones remain — a successful-looking install that reports nothing. It is
  also treated as `true` when its value is invalid, so a typo elsewhere in the
  policy can turn it on by accident.
- **`agentwatch doctor` does not read the managed file.** Detection looks at
  `~/.claude/settings.json` only, so doctor reports on the hooks *setup* wrote,
  not on the ones that will actually run. With `allowManagedHooksOnly` set those
  are different sets: doctor can say "hooks installed" about entries Claude Code
  is ignoring. Deploy the fragment and treat doctor as a check on the CLI and the
  backend, not on which hooks fire.
- **The hook command must be an absolute path** that resolves in the
  environment the agent is launched from. A GUI-launched agent does not get your
  shell's PATH, so an `nvm`/`fnm`/`asdf` shim path will resolve for you in a
  terminal and be missing for the same person from the Dock. Run
  `agentwatch doctor` on a reference machine — it validates the installed hook
  command and warns when it resolves through a version manager.
- **The token does not go in this file.** Claude Code fetches it at runtime
  through `otelHeadersHelper`, which is why the policy fragment carries an
  endpoint and no credential. Codex and Gemini have no such mechanism and do carry a
  static token in their own config, which is why the Edge keeps those files at
  mode `0600`.

## Uninstalling

```sh
agentwatch uninstall           # removes hooks and managed telemetry, restores backups
agentwatch uninstall --purge   # also removes ~/.agentwatch and queued data
```

Run it as the same user that ran setup, then remove the managed file if you
deployed one.

To stop collection without uninstalling — a paused pilot, an incident, a
developer working on something they would rather not have attributed — use
`agentwatch off`, which stops hooks and removes the native exporters while
keeping the configuration. `agentwatch on` puts it back. Both require restarting
running agents: an agent that is already up holds its exporters and headers in
memory.

## When the signed binary lands

These templates install through npm today, which means they depend on a Node.js
runtime being present and on the PATH of whatever launches the agent. A signed,
notarized native package is planned (see
[docs/ENTERPRISE_DEPLOYMENT.md](../../docs/ENTERPRISE_DEPLOYMENT.md)); when it
ships, only the install line in each script changes and the policy file above
does not change at all. That is the reason they are separate files.
