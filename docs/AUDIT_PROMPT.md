# Audit this package with your own coding agent

Paste the prompt below into Claude Code, Codex, Cursor or Gemini CLI with this
repository checked out. It asks the agent to answer the questions a security
reviewer asks about a telemetry collector, to cite a file and line for every
claim, and to list what it could not verify. Compare the report it produces
against [DATA_HANDLING.md](DATA_HANDLING.md): every question the report raises
should already be answered there, and if one is not, tell us.

Run it against the exact revision you intend to install. The findings are
only as good as the checkout they were made on.

---

```text
You are auditing @agent-watch-ai/edge, an open-source telemetry collector for
AI coding agents that a vendor wants me to install on every developer laptop.
Source: https://github.com/Agent-Watch-AI/agent-watch-edge
Package: https://www.npmjs.com/package/@agent-watch-ai/edge
Assume the vendor's documentation is wrong until the code proves it right.
Work only from the source in this checkout. Cite file:line for every claim.
Where you cannot verify something from source, say so explicitly rather than
guessing.

Answer each question in order. Keep the headings exactly as written so reports
from different reviewers can be compared.

## 1. Egress
List every place bytes leave the process over the network: every fetch, HTTP
client, socket, or child process that could reach the network. For each, name
the destination (hard-coded, configured, or derived), the authentication used,
and what payload shape it sends.

## 2. Filesystem reads
List every path the package reads outside its own installation directory.
Include agent configuration files, transcripts, git repositories, environment
variables and anything resolved from $HOME. State which of these are read on
every hook invocation versus only during setup.

## 3. Filesystem writes
List every path the package writes, with the file mode used. Call out any
write into another tool's configuration directory (~/.claude, ~/.codex,
~/.cursor, ~/.gemini) and whether the write is mergeful and backed up.

## 4. What is sent with a default install
With a fresh configuration and no flags changed, enumerate the fields of each
outbound record type. For each field state: sent verbatim, sent as a hash or
length, or never sent. Then answer directly: with the default configuration,
is there any code path through which prompt text, model response text, tool
input bodies, tool output bodies, or file contents leave the machine? If yes,
show the path.

## 5. The consent gate
Explain how content capture is enabled. Can a repository-level config file,
an environment variable, a command-line flag, or a corrupt or missing global
config enable it? Can a package upgrade re-enable capture that an older
config had on? Show the code that decides.

## 6. The sanitizer
Describe what the secret sanitizer removes and where it runs. Identify any
outbound path that bypasses it. Identify credential shapes it does not catch.
State whether it runs regardless of capture settings.

## 7. Credentials
Where is the ingest token stored, with what file mode, and which agent
configuration files does it get copied into? Can it appear in logs, doctor or
status output, queue files, backups, or shell history?

## 8. Native OpenTelemetry
The agents themselves can export OpenTelemetry directly to the backend. What
does this package configure for each agent, what content-related switches
does it set, and what in that traffic can the package's own sanitizer and
consent gate not filter?

## 9. Blast radius
What runs as a hook on every agent event, with what timeout, and what happens
on error, on a hung backend, or on a malformed payload? Can this package block,
crash or slow the developer's coding agent? Does it run any daemon, scheduled
task or self-updater?

## 10. Removal
Does agentwatch off stop all egress, including native exporters? Does
uninstall restore agent configuration to its previous state? What is left on
disk after uninstall --purge?

## 11. Supply chain
Read package.json and the lockfile. List runtime dependencies and postinstall
scripts. Note anything that downloads code at install or run time.

## 12. Verdict
Give a one-paragraph verdict. Then list, as a numbered list, the questions you
would still want the vendor to answer before installing, and the specific
things you could not verify from source.
```
