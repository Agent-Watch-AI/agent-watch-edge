import { asRecord, omitKeys } from '../../core/object.js';
import type { Env, UnknownRecord } from '../../core/types/core.types.js';
import { enabledSignalNames, otelEnabled, otlpBaseUrl } from '../../config/config.js';
import { backupFile } from '../../storage/atomic-file.js';
import { readJsonFile } from '../../storage/json-file.js';
import { HOOK_COMMAND_MARKER } from '../constants/provider.constants.js';
import { writeJsonValidated } from '../shared/hook-config.js';
import { withOtelInstall, withoutOtelInstall } from '../shared/install-record.js';
import type { NativeTelemetryConfigurator, NativeTelemetryStatus, SetupContext, SetupOutcome } from '../types/provider.types.js';
import { geminiSettingsPath } from './gemini.detect.js';
import { GEMINI_PROVIDER_ID } from './constants/gemini.constants.js';
import {
  ENV_BLOCK_KEY,
  GEMINI_LEGACY_OWNED_KEYS,
  GEMINI_OTLP_PROTOCOL,
  GEMINI_TELEMETRY_TARGET_LOCAL,
  LEGACY_HELPER_KEY,
  OTEL_EXPORTER_NONE,
  OTEL_EXPORTER_OTLP,
  OTLP_HEADERS_KEY,
  STANDARD_OTLP_PROTOCOL
} from './constants/gemini.otel.constants.js';

/**
 * The environment Gemini CLI actually reads.
 *
 * Every name here was verified against the installed `@google/gemini-cli`
 * bundle (`resolveTelemetrySettings`), because the previous set was written
 * from Claude Code's vocabulary and Gemini reads none of it:
 *
 * - `GEMINI_TELEMETRY_ENABLED`, not `GEMINI_ENABLE_TELEMETRY`. The latter
 *   appears nowhere in the CLI, and `initializeTelemetry()` returns immediately
 *   unless the former is set, so no exporter was ever created.
 * - Auth travels in `OTEL_EXPORTER_OTLP_HEADERS`. Gemini has no
 *   `otelHeadersHelper` — that is a Claude Code setting — so with the helper
 *   alone the exporter posted without an Authorization header and the gateway,
 *   which is fail-closed, answered 401 to every batch.
 *
 * @param context - Environment, paths and effective config.
 * @returns The desired variables, or undefined when telemetry is off or no
 *   backend is configured.
 */
export function desiredGeminiOtelEnv(context: SetupContext): Record<string, string> | undefined {
  const otlpBase = otlpBaseUrl(context.config);

  if (!otlpBase || !otelEnabled(context.config)) return undefined;

  const signals = context.config.otel;

  return {
    GEMINI_TELEMETRY_ENABLED: 'true',
    GEMINI_TELEMETRY_TARGET: GEMINI_TELEMETRY_TARGET_LOCAL,
    GEMINI_TELEMETRY_OTLP_ENDPOINT: otlpBase,
    GEMINI_TELEMETRY_OTLP_PROTOCOL: GEMINI_OTLP_PROTOCOL,
    GEMINI_TELEMETRY_TRACES_ENABLED: signals.traces ? 'true' : 'false',
    OTEL_METRICS_EXPORTER: signals.metrics ? OTEL_EXPORTER_OTLP : OTEL_EXPORTER_NONE,
    OTEL_LOGS_EXPORTER: signals.logs ? OTEL_EXPORTER_OTLP : OTEL_EXPORTER_NONE,
    OTEL_TRACES_EXPORTER: signals.traces ? OTEL_EXPORTER_OTLP : OTEL_EXPORTER_NONE,
    OTEL_EXPORTER_OTLP_PROTOCOL: STANDARD_OTLP_PROTOCOL,
    OTEL_EXPORTER_OTLP_ENDPOINT: otlpBase,
    ...(context.config.token ? { [OTLP_HEADERS_KEY]: `Authorization=Bearer ${context.config.token}` } : {})
  };
}

/** Configures Gemini CLI's own OTLP export. */
export class GeminiOtelConfigurator implements NativeTelemetryConfigurator {
  /**
   * Whether this agent can export native telemetry at all.
   *
   * @param _env - Unused; Gemini CLI always supports it.
   * @returns Always true.
   */
  async supported(_env: Env): Promise<boolean> {
    return true;
  }

  /**
   * Report whether the machine's telemetry configuration matches what we want.
   *
   * @param context - Environment, paths, config and install state.
   * @returns The status, naming any foreign configuration in the way.
   */
  async inspect(context: SetupContext): Promise<NativeTelemetryStatus> {
    const disabled = !otelEnabled(context.config);
    const read = await readJsonFile(geminiSettingsPath(context.env));
    const settings = read.state === 'ok' ? asRecord(read.value) : undefined;

    if (!settings) {
      if (disabled && read.state === 'missing') return { supported: true, configured: true, detail: 'disabled in config (otel)' };

      return { supported: true, configured: false, detail: read.state === 'invalid' ? 'settings unparseable' : 'no settings file' };
    }

    const envBlock = asRecord(settings[ENV_BLOCK_KEY]) ?? {};
    const ownedKeys = ownedKeysOf(context);

    if (disabled) return inspectDisabled(settings, envBlock, ownedKeys);

    const desired = desiredGeminiOtelEnv(context);

    if (!desired) return { supported: true, configured: false, detail: 'no backend endpoint configured' };

    const matches = Object.entries(desired).every(([key, value]) => envBlock[key] === value);

    // A helper entry left by an older version is dead weight Gemini ignores;
    // reporting "configured" would hide that setup still has work to do. A
    // helper belonging to another tool is none of our business.
    if (matches && !hasOurLegacyHelper(settings)) return { supported: true, configured: true };

    if (matches) return { supported: true, configured: false, detail: 'stale otelHeadersHelper entry — run `agentwatch setup`' };

    const conflicting = foreignKeys(envBlock, desired, ownedKeys);

    if (conflicting.length > 0) {
      return { supported: true, configured: false, conflict: `existing telemetry env vars: ${conflicting.join(', ')}` };
    }

    return { supported: true, configured: false };
  }

  /**
   * Write the telemetry configuration into Gemini CLI's settings.
   *
   * @param context - Environment, paths, config and install state.
   * @returns Whether the file changed, what to tell the user, and the next
   *   install state.
   */
  async configure(context: SetupContext): Promise<SetupOutcome> {
    const desired = desiredGeminiOtelEnv(context);

    if (!desired) return this.configureDisabled(context);

    const settingsPath = geminiSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);

    if (read.state === 'invalid') {
      return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
    }

    if (read.state === 'ok' && !asRecord(read.value)) {
      return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
    }

    const settings: UnknownRecord = (read.state === 'ok' ? asRecord(read.value) : undefined) ?? {};
    const envBlock = asRecord(settings[ENV_BLOCK_KEY]) ?? {};
    const ownedKeys = ownedKeysOf(context);
    const conflicting = foreignKeys(envBlock, desired, ownedKeys);

    if (conflicting.length > 0) {
      return {
        ok: false,
        changed: false,
        messages: [`skipping native OpenTelemetry: ${conflicting.join(', ')} already set in ${settingsPath} (not AgentWatch-owned)`]
      };
    }

    // Keys we own that this configuration no longer wants (a signal turned off
    // since the last run) would otherwise linger.
    const stale = new Set(ownedKeys.filter((key) => key !== LEGACY_HELPER_KEY && desired[key] === undefined));
    const withEnv: UnknownRecord = { ...settings, [ENV_BLOCK_KEY]: { ...omitKeys(envBlock, stale), ...desired } };
    // Gemini never read this; leaving it behind only confuses the next reader.
    const nextSettings = hasOurLegacyHelper(withEnv) ? omitKeys(withEnv, new Set([LEGACY_HELPER_KEY])) : withEnv;
    const changed = JSON.stringify(nextSettings) !== JSON.stringify(settings);

    if (changed) {
      await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
      await writeJsonValidated(settingsPath, nextSettings);
    }

    return {
      ok: true,
      changed,
      messages: changed
        ? [`native OpenTelemetry configured (signals: ${enabledSignalNames(context.config.otel).join(', ')})`, 'restart running Gemini CLI sessions to pick it up']
        : ['native OpenTelemetry already up to date'],
      installState: withOtelInstall(context.installState, GEMINI_PROVIDER_ID, {
        configPath: settingsPath,
        ownedKeys: Object.keys(desired),
        configuredAt: context.env.now()
      })
    };
  }

  /**
   * Remove the telemetry configuration AgentWatch wrote.
   *
   * @param context - Environment, paths, config and install state.
   * @returns Whether the file changed, what to tell the user, and the next
   *   install state.
   */
  async uninstall(context: SetupContext): Promise<SetupOutcome> {
    const settingsPath = geminiSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);

    if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Gemini settings file'] };

    if (read.state === 'invalid') {
      return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
    }

    const settings = asRecord(read.value);

    if (!settings) {
      return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
    }

    const removable = new Set(
      (context.installState.agents[GEMINI_PROVIDER_ID]?.otelOwnedKeys ?? GEMINI_LEGACY_OWNED_KEYS).filter((key) => key !== LEGACY_HELPER_KEY)
    );
    const nextSettings = strippedSettings(settings, removable);
    const changed = JSON.stringify(nextSettings) !== JSON.stringify(settings);

    if (changed) {
      await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
      await writeJsonValidated(settingsPath, nextSettings);
    }

    return {
      ok: true,
      changed,
      messages: changed ? ['native OpenTelemetry configuration removed'] : ['no AgentWatch OpenTelemetry configuration found'],
      installState: withoutOtelInstall(context.installState, GEMINI_PROVIDER_ID)
    };
  }

  /**
   * Handle `configure` when telemetry is off or unconfigurable.
   *
   * @param context - Environment, paths, config and install state.
   * @returns The outcome.
   */
  private async configureDisabled(context: SetupContext): Promise<SetupOutcome> {
    if (otelEnabled(context.config)) return { ok: false, changed: false, messages: ['no backend endpoint configured'] };

    const removed = await this.uninstall(context);

    if (!removed.ok) return removed;

    return {
      ok: true,
      changed: removed.changed,
      messages: [
        removed.changed
          ? 'native OpenTelemetry disabled in config; previous configuration removed'
          : 'native OpenTelemetry disabled in config (otel: none)'
      ],
      installState: removed.installState
    };
  }
}

/**
 * Settings keys a previous AgentWatch setup recorded as its own.
 *
 * @param context - Install state carrier.
 * @returns The recorded keys.
 */
function ownedKeysOf(context: SetupContext): readonly string[] {
  return context.installState.agents[GEMINI_PROVIDER_ID]?.otelOwnedKeys ?? [];
}

/**
 * Status when telemetry is deliberately off.
 *
 * @param settings - The whole settings object.
 * @param envBlock - Its env block.
 * @param ownedKeys - Keys a previous setup recorded.
 * @returns Configured, unless our own leftovers are still in place.
 */
function inspectDisabled(settings: UnknownRecord, envBlock: UnknownRecord, ownedKeys: readonly string[]): NativeTelemetryStatus {
  const leftover =
    ownedKeys.some((key) => (key === LEGACY_HELPER_KEY ? settings[key] !== undefined : envBlock[key] !== undefined)) || hasOurLegacyHelper(settings);

  if (!leftover) return { supported: true, configured: true, detail: 'disabled in config (otel)' };

  return {
    supported: true,
    configured: false,
    detail: 'disabled in config, but previous telemetry env vars remain — run `agentwatch setup`'
  };
}

/**
 * Desired keys already set to a value we did not write.
 *
 * @param envBlock - Current env block.
 * @param desired - What we want to write.
 * @param ownedKeys - Keys a previous setup recorded as ours.
 * @returns The conflicting key names.
 */
function foreignKeys(envBlock: UnknownRecord, desired: Record<string, string>, ownedKeys: readonly string[]): string[] {
  const owned = new Set(ownedKeys);

  return Object.keys(desired).filter((key) => envBlock[key] !== undefined && envBlock[key] !== desired[key] && !owned.has(key));
}

/**
 * Settings with our telemetry keys and legacy helper removed.
 *
 * @param settings - The whole settings object.
 * @param removable - Env keys to drop.
 * @returns The next settings object.
 */
function strippedSettings(settings: UnknownRecord, removable: ReadonlySet<string>): UnknownRecord {
  const withoutHelper = hasOurLegacyHelper(settings) ? omitKeys(settings, new Set([LEGACY_HELPER_KEY])) : settings;
  const envBlock = asRecord(withoutHelper[ENV_BLOCK_KEY]);

  if (!envBlock) return withoutHelper;

  const nextEnv = omitKeys(envBlock, removable);

  // An emptied env block is dropped rather than left as `"env": {}`.
  if (Object.keys(nextEnv).length === 0) return omitKeys(withoutHelper, new Set([ENV_BLOCK_KEY]));

  return { ...withoutHelper, [ENV_BLOCK_KEY]: nextEnv };
}

/**
 * Whether the settings carry an `otelHeadersHelper` this tool wrote, as
 * opposed to somebody else's.
 *
 * @param settings - The whole settings object.
 * @returns True when the entry is ours.
 */
function hasOurLegacyHelper(settings: UnknownRecord): boolean {
  const value = settings[LEGACY_HELPER_KEY];

  return typeof value === 'string' && value.includes(HOOK_COMMAND_MARKER);
}
