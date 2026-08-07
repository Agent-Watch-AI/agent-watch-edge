import fs from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { joinUrl, otlpBaseUrl } from '../../config/config.js';
import type { Env } from '../../core/env.js';
import type { NativeTelemetryConfigurator, NativeTelemetryStatus, SetupContext, SetupOutcome } from '../provider.js';
import { codexConfigTomlPath } from './codex.detect.js';

/**
 * Codex native OpenTelemetry (verified against openai/codex source, 2026-08):
 * [otel] table in ~/.codex/config.toml; log export is opt-in via
 * `exporter = { otlp-http = { endpoint, protocol, headers } }`. Token usage
 * arrives as codex.sse_event log events keyed by conversation.id, which also
 * carry auth_mode (ApiKey/Chatgpt) for billing-mode attribution.
 *
 * Project-level .codex/config.toml ignores the `otel` key, so only the
 * user-level file works. We never rewrite the user's TOML through a parser
 * (comments/formatting would be lost); instead we own a marker-delimited
 * block appended to the file, and only when no foreign [otel] table exists.
 */
const BLOCK_START = '# >>> agentwatch managed block — do not edit; `agentwatch uninstall` removes it >>>';
const BLOCK_END = '# <<< agentwatch managed block <<<';

export class CodexOtelConfigurator implements NativeTelemetryConfigurator {
  async supported(_env: Env): Promise<boolean> {
    return true;
  }

  async inspect(context: SetupContext): Promise<NativeTelemetryStatus> {
    const configPath = codexConfigTomlPath(context.env);
    const raw = await readFileOrUndefined(configPath);
    if (raw === undefined) return { supported: true, configured: false, detail: 'no config.toml' };
    const hasBlock = raw.includes(BLOCK_START);
    if (hasBlock) return { supported: true, configured: true };
    const parsed = tryParseToml(raw);
    if (parsed === undefined) return { supported: true, configured: false, detail: 'config.toml unparseable' };
    if (parsed['otel'] !== undefined) {
      return { supported: true, configured: false, conflict: 'an [otel] section not owned by AgentWatch already exists' };
    }
    return { supported: true, configured: false };
  }

  async configure(context: SetupContext): Promise<SetupOutcome> {
    const otlpBase = otlpBaseUrl(context.config);
    if (!otlpBase) return { ok: false, changed: false, messages: ['no backend endpoint configured'] };

    const configPath = codexConfigTomlPath(context.env);
    const raw = (await readFileOrUndefined(configPath)) ?? '';
    const block = renderBlock(otlpBase, context.config.token);

    let next: string;
    if (raw.includes(BLOCK_START)) {
      const replaced = replaceBlock(raw, block);
      if (replaced === undefined) {
        return { ok: false, changed: false, messages: [`malformed AgentWatch block markers in ${configPath}; fix manually`] };
      }
      next = replaced;
    } else {
      const parsed = tryParseToml(raw);
      if (raw.trim() !== '' && parsed === undefined) {
        return { ok: false, changed: false, messages: [`refusing to modify unparseable ${configPath}`] };
      }
      if (parsed && parsed['otel'] !== undefined) {
        return { ok: false, changed: false, messages: [`skipping native OpenTelemetry: ${configPath} already has an [otel] section (not AgentWatch-owned)`] };
      }
      const separator = raw === '' || raw.endsWith('\n') ? '' : '\n';
      next = raw + separator + (raw.trim() === '' ? '' : '\n') + block;
    }

    if (next === raw) {
      return { ok: true, changed: false, messages: ['native OpenTelemetry already configured'] };
    }
    if (tryParseToml(next) === undefined) {
      return { ok: false, changed: false, messages: ['internal error: generated config.toml would not parse; nothing written'] };
    }
    await backupFile(configPath, context.paths.backupsDir, context.env.now());
    await writeFileAtomic(configPath, next);

    context.installState.agents['codex'] = {
      ...context.installState.agents['codex'],
      hookEvents: context.installState.agents['codex']?.hookEvents ?? [],
      notes: context.installState.agents['codex']?.notes ?? [],
      otelConfiguredAt: context.env.now().toISOString(),
      otelConfigPath: configPath,
      otelOwnedKeys: ['otel']
    };
    return {
      ok: true,
      changed: true,
      messages: ['native OpenTelemetry configured (token usage export)', 'restart running Codex sessions to pick it up']
    };
  }

  async uninstall(context: SetupContext): Promise<SetupOutcome> {
    const configPath = codexConfigTomlPath(context.env);
    const raw = await readFileOrUndefined(configPath);
    if (raw === undefined || !raw.includes(BLOCK_START)) {
      return { ok: true, changed: false, messages: ['no AgentWatch telemetry configuration found'] };
    }
    const next = replaceBlock(raw, undefined);
    if (next === undefined) {
      return { ok: false, changed: false, messages: [`malformed AgentWatch block markers in ${configPath}; fix manually`] };
    }
    await backupFile(configPath, context.paths.backupsDir, context.env.now());
    await writeFileAtomic(configPath, next);
    const codexState = context.installState.agents['codex'];
    if (codexState) {
      delete codexState.otelConfiguredAt;
      codexState.otelOwnedKeys = [];
    }
    return { ok: true, changed: true, messages: ['native OpenTelemetry configuration removed'] };
  }
}

function renderBlock(otlpBase: string, token: string | undefined): string {
  // OTLP/HTTP log endpoint is the full path (docs example: .../v1/logs).
  const endpoint = joinUrl(otlpBase, '/v1/logs');
  const headers = token ? `, headers = { "Authorization" = "Bearer ${escapeTomlString(token)}" }` : '';
  return [
    BLOCK_START,
    '[otel]',
    `exporter = { otlp-http = { endpoint = "${escapeTomlString(endpoint)}", protocol = "binary"${headers} } }`,
    BLOCK_END,
    ''
  ].join('\n');
}

/** Replace (or remove, when block is undefined) the marker-delimited block. */
function replaceBlock(raw: string, block: string | undefined): string | undefined {
  const startIndex = raw.indexOf(BLOCK_START);
  const endIndex = raw.indexOf(BLOCK_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return undefined;
  const afterEnd = endIndex + BLOCK_END.length;
  const tail = raw.slice(afterEnd).replace(/^\n/, '');
  const head = raw.slice(0, startIndex);
  if (block === undefined) {
    return head.replace(/\n+$/, '\n') + tail;
  }
  return head + block + tail;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function tryParseToml(raw: string): Record<string, unknown> | undefined {
  try {
    return parseToml(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
