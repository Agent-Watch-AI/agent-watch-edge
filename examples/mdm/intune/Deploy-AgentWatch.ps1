<#
.SYNOPSIS
  Deploy AgentWatch Edge — Intune platform script (Windows).

.DESCRIPTION
  Run in the **user** context, not system: the Edge writes into that person's own
  agent configuration and attributes turns to their identity, so a system-context
  run would configure the system account's agents and nobody else's. Set
  "Run this script using the logged on credentials" to Yes.

  Windows is not a verified deployment target — see docs/ENTERPRISE_DEPLOYMENT.md.
  The hooks are written and the CLI runs, but the rollout has not been validated
  end to end on a managed Windows fleet. Pilot it on a handful of machines before
  a fleet-wide assignment.

.PARAMETER Endpoint
  Backend base URL, e.g. https://backend.example.com. Defaults to the
  AGENTWATCH_ENDPOINT environment variable.

.PARAMETER Token
  Enrollment token. Defaults to the AGENTWATCH_TOKEN environment variable, and
  is handed to setup that way rather than through --token, because argv is
  visible to process inspection.

  Intune runs a platform script as `powershell.exe -ExecutionPolicy Bypass -File
  <script>` with no arguments and no console, so there is no parameter mechanism
  and no prompt to answer: neither parameter can be Mandatory. Set both as
  machine environment variables first — a separate platform script, a
  configuration profile, or the packaged Win32 app that wraps this one — or edit
  the defaults below before assigning it.

.NOTES
  Exit codes: 0 installed and verified · 1 install failed · 3 enrolled but
  doctor reported a problem.
#>

[CmdletBinding()]
param(
  [string]$Endpoint = $env:AGENTWATCH_ENDPOINT,
  [string]$Token = $env:AGENTWATCH_TOKEN
)

$ErrorActionPreference = 'Stop'

# Fail with a readable message rather than blocking on a prompt no Intune script
# has a console to answer.
if ([string]::IsNullOrWhiteSpace($Endpoint) -or [string]::IsNullOrWhiteSpace($Token)) {
  Write-Error 'Endpoint and Token are required: set AGENTWATCH_ENDPOINT and AGENTWATCH_TOKEN as machine environment variables, or pass -Endpoint/-Token from a wrapper.'
  exit 1
}

$package = '@agent-watch-ai/edge'
$log = Join-Path $env:LOCALAPPDATA 'agentwatch-doctor.json'

# Until the signed .msi ships, install through npm. Only this block changes when
# it does; the Claude Code managed policy file does not change at all.
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error 'npm not found: install Node.js 20+ before this script'
  exit 1
}

npm install -g --no-fund --no-audit $package
if ($LASTEXITCODE -ne 0) { exit 1 }

# --yes suppresses every prompt, including the developer-email one. The identity
# falls back to this user's `git config user.email`; setup refuses rather than
# installing something it cannot attribute.
# AGENTWATCH_TOKEN rather than --token: argv is visible to process inspection for
# the life of the process.
$env:AGENTWATCH_TOKEN = $Token
try {
  agentwatch setup --endpoint $Endpoint --yes
  if ($LASTEXITCODE -ne 0) { exit 1 }
} finally {
  Remove-Item Env:\AGENTWATCH_TOKEN -ErrorAction SilentlyContinue
}

# Verify rather than assume. `doctor` exits non-zero on a real problem — a hook
# command that does not resolve, an unreachable backend, a missing identity.
agentwatch doctor --json | Out-File -FilePath $log -Encoding utf8
if ($LASTEXITCODE -ne 0) {
  Write-Warning "enrolled, but doctor reported a problem; see $log"
  exit 3
}

Write-Output "AgentWatch enrolled for $env:USERNAME"

# Codex, if present, still needs one manual step this script cannot perform: the
# developer runs `codex`, then `/hooks`, and trusts the AgentWatch entries.
