import { readJsonFile } from '../../storage/json-file.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { otlpBaseUrl } from '../../config/config.js';
import type { Env } from '../../core/env.js';
import type { NativeTelemetryConfigurator, NativeTelemetryStatus, SetupContext, SetupOutcome } from '../provider.js';
import { claudeSettingsPath } from './claude.detect.js';

/**
 * Claude Code native OpenTelemetry (verified: code.claude.com/docs/en/monitoring-usage, 2026-08).
 * Configured through the settings.json `env` block. Bearer auth goes through
 * the documented `otelHeadersHelper` so the token never lands in Claude's
 * settings file. Usage arrives at the backend as claude_code.token.usage /
 * claude_code.api_request keyed by session.id == hook session_id.
 */
export function desiredClaudeOtelEnv(context: SetupContext): Record<string, string> | undefined {
  const otlpBase = otlpBaseUrl(context.config);
  if (!otlpBase) return undefined;
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    // No default protocol exists; must be explicit.
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: otlpBase
  };
}

const HEADERS_HELPER_KEY = 'otelHeadersHelper';

export class ClaudeOtelConfigurator implements NativeTelemetryConfigurator {
  async supported(_env: Env): Promise<boolean> {
    return true;
  }

  async inspect(context: SetupContext): Promise<NativeTelemetryStatus> {
    const settingsPath = claudeSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);
    if (read.state !== 'ok' || !isRecord(read.value)) {
      return { supported: true, configured: false, detail: read.state === 'invalid' ? 'settings unparseable' : 'no settings file' };
    }
    const env = isRecord(read.value['env']) ? (read.value['env'] as Record<string, unknown>) : {};
    const desired = desiredClaudeOtelEnv(context);
    if (!desired) return { supported: true, configured: false, detail: 'no backend endpoint configured' };

    const ownedKeys = context.installState.agents['claude']?.otelOwnedKeys ?? [];
    const matches = Object.entries(desired).every(([key, value]) => env[key] === value);
    if (matches) return { supported: true, configured: true };

    const conflicting = Object.keys(desired).filter((key) => env[key] !== undefined && env[key] !== desired[key] && !ownedKeys.includes(key));
    if (conflicting.length > 0) {
      return { supported: true, configured: false, conflict: `existing telemetry env vars: ${conflicting.join(', ')}` };
    }
    return { supported: true, configured: false };
  }

  async configure(context: SetupContext): Promise<SetupOutcome> {
    const desired = desiredClaudeOtelEnv(context);
    if (!desired) return { ok: false, changed: false, messages: ['no backend endpoint configured'] };

    const settingsPath = claudeSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);
    if (read.state === 'invalid') {
      return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
    }
    const settings: Record<string, unknown> = read.state === 'ok' && isRecord(read.value) ? read.value : {};
    if (read.state === 'ok' && !isRecord(read.value)) {
      return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
    }

    const envBlock: Record<string, unknown> = isRecord(settings['env']) ? (settings['env'] as Record<string, unknown>) : {};
    const ownedKeys = context.installState.agents['claude']?.otelOwnedKeys ?? [];
    const conflicting = Object.keys(desired).filter(
      (key) => envBlock[key] !== undefined && envBlock[key] !== desired[key] && !ownedKeys.includes(key)
    );
    if (conflicting.length > 0) {
      return {
        ok: false,
        changed: false,
        messages: [`skipping native OpenTelemetry: ${conflicting.join(', ')} already set in ${settingsPath} (not AgentWatch-owned)`]
      };
    }

    const before = JSON.stringify(settings);
    settings['env'] = envBlock;
    Object.assign(envBlock, desired);

    const owned = new Set(Object.keys(desired));
    if (context.config.token) {
      const helperCommand = headersHelperCommand(context.hookCommand);
      const existingHelper = settings[HEADERS_HELPER_KEY];
      if (existingHelper !== undefined && typeof existingHelper === 'string' && !existingHelper.includes('agentwatch') && existingHelper !== helperCommand) {
        return { ok: false, changed: false, messages: [`skipping native OpenTelemetry: ${HEADERS_HELPER_KEY} already set to a non-AgentWatch helper`] };
      }
      settings[HEADERS_HELPER_KEY] = helperCommand;
      owned.add(HEADERS_HELPER_KEY);
    }

    const changed = JSON.stringify(settings) !== before;
    if (changed) {
      await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
      const serialized = JSON.stringify(settings, null, 2) + '\n';
      JSON.parse(serialized);
      await writeFileAtomic(settingsPath, serialized);
    }

    context.installState.agents['claude'] = {
      ...context.installState.agents['claude'],
      hookEvents: context.installState.agents['claude']?.hookEvents ?? [],
      notes: context.installState.agents['claude']?.notes ?? [],
      otelConfiguredAt: context.env.now().toISOString(),
      otelConfigPath: settingsPath,
      otelOwnedKeys: [...owned]
    };

    return {
      ok: true,
      changed,
      messages: changed
        ? ['native OpenTelemetry configured (token usage & cost export)', 'restart running Claude Code sessions to pick it up']
        : ['native OpenTelemetry already configured']
    };
  }

  async uninstall(context: SetupContext): Promise<SetupOutcome> {
    const settingsPath = claudeSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);
    if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Claude settings file'] };
    if (read.state === 'invalid' || !isRecord(read.value)) {
      return { ok: false, changed: false, messages: [`cannot parse ${settingsPath}; not modified`] };
    }
    const settings = read.value as Record<string, unknown>;
    const desired = desiredClaudeOtelEnv(context) ?? {};
    const recorded = context.installState.agents['claude']?.otelOwnedKeys ?? [];
    // Fall back to the well-known keys, but only when their values are the
    // ones we would have written — never remove user-owned telemetry config.
    const removable = recorded.length > 0 ? recorded : Object.keys(desired);

    let changed = false;
    const envBlock = isRecord(settings['env']) ? (settings['env'] as Record<string, unknown>) : undefined;
    if (envBlock) {
      for (const key of removable) {
        if (key === HEADERS_HELPER_KEY) continue;
        if (envBlock[key] === undefined) continue;
        if (recorded.length === 0 && desired[key] !== undefined && envBlock[key] !== desired[key]) continue;
        delete envBlock[key];
        changed = true;
      }
      if (Object.keys(envBlock).length === 0) delete settings['env'];
    }
    const helper = settings[HEADERS_HELPER_KEY];
    if (typeof helper === 'string' && helper.includes('agentwatch')) {
      delete settings[HEADERS_HELPER_KEY];
      changed = true;
    }

    if (changed) {
      await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
      const serialized = JSON.stringify(settings, null, 2) + '\n';
      JSON.parse(serialized);
      await writeFileAtomic(settingsPath, serialized);
    }
    const claudeState = context.installState.agents['claude'];
    if (claudeState) {
      delete claudeState.otelConfiguredAt;
      claudeState.otelOwnedKeys = [];
    }
    return { ok: true, changed, messages: changed ? ['native OpenTelemetry configuration removed'] : ['no AgentWatch telemetry configuration found'] };
  }
}

export function headersHelperCommand(hookCommand: string): string {
  // hookCommand is "<bin> hook --agent claude"; reuse the same binary path.
  const bin = hookCommand.replace(/\s+hook\s+--agent\s+\S+\s*$/, '');
  return `${bin} otel-headers`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
