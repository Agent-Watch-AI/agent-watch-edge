import { readJsonFile } from '../../storage/json-file.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { enabledSignalNames, otelEnabled, otlpBaseUrl } from '../../config/config.js';
import type { Env } from '../../core/env.js';
import type { NativeTelemetryConfigurator, NativeTelemetryStatus, SetupContext, SetupOutcome } from '../provider.js';
import { geminiSettingsPath } from './gemini.detect.js';

export function desiredGeminiOtelEnv(context: SetupContext): Record<string, string> | undefined {
  const otlpBase = otlpBaseUrl(context.config);
  if (!otlpBase) return undefined;
  const signals = context.config.otel;
  if (!otelEnabled(context.config)) return undefined;
  const env: Record<string, string> = {
    GEMINI_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: signals.metrics ? 'otlp' : 'none',
    OTEL_LOGS_EXPORTER: signals.logs ? 'otlp' : 'none',
    OTEL_TRACES_EXPORTER: signals.traces ? 'otlp' : 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: otlpBase
  };
  return env;
}

const HEADERS_HELPER_KEY = 'otelHeadersHelper';

export class GeminiOtelConfigurator implements NativeTelemetryConfigurator {
  async supported(_env: Env): Promise<boolean> {
    return true;
  }

  async inspect(context: SetupContext): Promise<NativeTelemetryStatus> {
    const disabled = !otelEnabled(context.config);
    const settingsPath = geminiSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);
    if (read.state !== 'ok' || !isRecord(read.value)) {
      if (disabled && read.state === 'missing') return { supported: true, configured: true, detail: 'disabled in config (otel)' };
      return { supported: true, configured: false, detail: read.state === 'invalid' ? 'settings unparseable' : 'no settings file' };
    }
    const settings = read.value as Record<string, unknown>;
    const env = isRecord(settings['env']) ? (settings['env'] as Record<string, unknown>) : {};
    if (disabled) {
      const recorded = context.installState.agents['gemini']?.otelOwnedKeys ?? [];
      const leftover = recorded.some((key) => (key === HEADERS_HELPER_KEY ? settings[key] !== undefined : env[key] !== undefined));
      return leftover
        ? { supported: true, configured: false, detail: 'disabled in config, but previous telemetry env vars remain — run `agentwatch setup`' }
        : { supported: true, configured: true, detail: 'disabled in config (otel)' };
    }
    const desired = desiredGeminiOtelEnv(context);
    if (!desired) return { supported: true, configured: false, detail: 'no backend endpoint configured' };

    const ownedKeys = context.installState.agents['gemini']?.otelOwnedKeys ?? [];
    const matches = Object.entries(desired).every(([key, value]) => env[key] === value);
    if (matches) return { supported: true, configured: true };

    const conflicting = Object.keys(desired).filter((key) => env[key] !== undefined && env[key] !== desired[key] && !ownedKeys.includes(key));
    if (conflicting.length > 0) {
      return { supported: true, configured: false, conflict: `existing telemetry env vars: ${conflicting.join(', ')}` };
    }
    return { supported: true, configured: false };
  }

  async configure(context: SetupContext): Promise<SetupOutcome> {
    const desired = desiredGeminiOtelEnv(context);
    if (!desired) {
      if (!otelEnabled(context.config)) {
        const removed = await this.uninstall(context);
        if (!removed.ok) return removed;
        return {
          ok: true,
          changed: removed.changed,
          messages: [removed.changed ? 'native OpenTelemetry disabled in config; previous configuration removed' : 'native OpenTelemetry disabled in config (otel: none)']
        };
      }
      return { ok: false, changed: false, messages: ['no backend endpoint configured'] };
    }

    const settingsPath = geminiSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);
    if (read.state === 'invalid') {
      return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
    }
    const settings: Record<string, unknown> = read.state === 'ok' && isRecord(read.value) ? read.value : {};
    if (read.state === 'ok' && !isRecord(read.value)) {
      return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
    }

    const envBlock: Record<string, unknown> = isRecord(settings['env']) ? (settings['env'] as Record<string, unknown>) : {};
    const ownedKeys = context.installState.agents['gemini']?.otelOwnedKeys ?? [];
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
    for (const key of ownedKeys) {
      if (key === HEADERS_HELPER_KEY) continue;
      if (desired[key] === undefined) delete envBlock[key];
    }

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

    context.installState.agents['gemini'] = {
      ...context.installState.agents['gemini'],
      hookEvents: context.installState.agents['gemini']?.hookEvents ?? [],
      notes: context.installState.agents['gemini']?.notes ?? [],
      otelConfiguredAt: context.env.now().toISOString(),
      otelConfigPath: settingsPath,
      otelOwnedKeys: [...owned]
    };

    return {
      ok: true,
      changed,
      messages: changed
        ? [`native OpenTelemetry configured (signals: ${enabledSignalNames(context.config.otel).join(', ')})`, 'restart running Gemini CLI sessions to pick it up']
        : ['native OpenTelemetry already up to date']
    };
  }

  async uninstall(context: SetupContext): Promise<SetupOutcome> {
    const settingsPath = geminiSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);
    if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Gemini settings file'] };
    if (read.state === 'invalid') {
      return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
    }
    if (!isRecord(read.value)) {
      return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
    }

    const settings = read.value as Record<string, unknown>;
    const envBlock = isRecord(settings['env']) ? (settings['env'] as Record<string, unknown>) : undefined;
    const ownedKeys = context.installState.agents['gemini']?.otelOwnedKeys ?? [
      'GEMINI_ENABLE_TELEMETRY',
      'OTEL_METRICS_EXPORTER',
      'OTEL_LOGS_EXPORTER',
      'OTEL_TRACES_EXPORTER',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      HEADERS_HELPER_KEY
    ];

    const before = JSON.stringify(settings);
    if (envBlock) {
      for (const key of ownedKeys) {
        if (key === HEADERS_HELPER_KEY) continue;
        delete envBlock[key];
      }
      if (Object.keys(envBlock).length === 0) delete settings['env'];
    }
    if (ownedKeys.includes(HEADERS_HELPER_KEY) && typeof settings[HEADERS_HELPER_KEY] === 'string' && (settings[HEADERS_HELPER_KEY] as string).includes('agentwatch')) {
      delete settings[HEADERS_HELPER_KEY];
    }

    const changed = JSON.stringify(settings) !== before;
    if (changed) {
      await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
      const serialized = JSON.stringify(settings, null, 2) + '\n';
      JSON.parse(serialized);
      await writeFileAtomic(settingsPath, serialized);
    }

    const geminiState = context.installState.agents['gemini'];
    if (geminiState) {
      delete geminiState.otelConfiguredAt;
      geminiState.otelOwnedKeys = [];
    }

    return {
      ok: true,
      changed,
      messages: changed ? ['native OpenTelemetry configuration removed'] : ['no AgentWatch OpenTelemetry configuration found']
    };
  }
}

export function headersHelperCommand(hookCommand: string): string {
  const bin = hookCommand.replace(/\s+hook\s+--agent\s+\S+\s*$/, '');
  return `${bin} otel-headers`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
