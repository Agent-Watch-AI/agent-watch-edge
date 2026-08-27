import { asRecord, omitKeys } from '../../core/object.js';
import type { Env, UnknownRecord } from '../../core/types/core.types.js';
import { enabledSignalNames, otelEnabled, otlpBaseUrl } from '../../config/config.js';
import { backupFile } from '../../storage/atomic-file.js';
import { readJsonFile } from '../../storage/json-file.js';
import { writeJsonValidated } from '../shared/hook-config.js';
import { withOtelInstall, withoutOtelInstall } from '../shared/install-record.js';
import { HOOK_COMMAND_MARKER } from '../constants/provider.constants.js';
import type { NativeTelemetryConfigurator, NativeTelemetryStatus, SetupContext, SetupOutcome } from '../types/provider.types.js';
import { claudeSettingsPath } from './claude.detect.js';
import { CLAUDE_PROVIDER_ID } from './constants/claude.constants.js';
import {
  ENV_BLOCK_KEY,
  HEADERS_HELPER_KEY,
  OTEL_EXPORTER_NONE,
  OTEL_EXPORTER_OTLP,
  OTLP_PROTOCOL,
  RE_HOOK_SUFFIX
} from './constants/claude.otel.constants.js';

/**
 * The telemetry environment AgentWatch wants in Claude Code's settings.
 *
 * Claude Code's native OpenTelemetry (verified against
 * code.claude.com/docs/en/monitoring-usage, 2026-08) is configured through the
 * settings.json `env` block. Each `claude_code.api_request` log becomes one
 * llm.call; the enhanced-traces beta adds `claude_code.llm_request` spans
 * carrying query_source/agent_id, which is what keeps child-agent traffic from
 * being folded into the main agent.
 *
 * @param context - Environment, paths and effective config.
 * @returns The desired variables, or undefined when telemetry is off or no
 *   backend is configured.
 */
export function desiredClaudeOtelEnv(context: SetupContext): Record<string, string> | undefined {
  const otlpBase = otlpBaseUrl(context.config);

  if (!otlpBase || !otelEnabled(context.config)) return undefined;

  const signals = context.config.otel;

  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: signals.metrics ? OTEL_EXPORTER_OTLP : OTEL_EXPORTER_NONE,
    OTEL_LOGS_EXPORTER: signals.logs ? OTEL_EXPORTER_OTLP : OTEL_EXPORTER_NONE,
    OTEL_TRACES_EXPORTER: signals.traces ? OTEL_EXPORTER_OTLP : OTEL_EXPORTER_NONE,
    // No default protocol exists; it has to be explicit.
    OTEL_EXPORTER_OTLP_PROTOCOL: OTLP_PROTOCOL,
    OTEL_EXPORTER_OTLP_ENDPOINT: otlpBase,
    // The beta flag only adds the llm_request spans; it stays tied to traces.
    ...(signals.traces ? { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' } : {})
  };
}

/**
 * The `agentwatch otel-headers` command for this install.
 *
 * Bearer auth goes through Claude's documented header-helper hook so the token
 * never lands in the settings file — which is world-readable, committed by some
 * users, and backed up by others.
 *
 * @param hookCommand - The generated `<bin> hook --agent claude` command.
 * @returns The helper command reusing the same binary path.
 */
export function headersHelperCommand(hookCommand: string): string {
  return `${hookCommand.replace(RE_HOOK_SUFFIX, '')} otel-headers`;
}

/**
 * Configures Claude Code's own OTLP export, which is where the llm.call usage
 * ledger comes from.
 */
export class ClaudeOtelConfigurator implements NativeTelemetryConfigurator {
  /**
   * Whether this agent can export native telemetry at all.
   *
   * @param _env - Unused; Claude Code always supports it.
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
    const settingsPath = claudeSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);
    const settings = read.state === 'ok' ? asRecord(read.value) : undefined;

    if (!settings) {
      if (disabled && read.state === 'missing') return { supported: true, configured: true, detail: 'disabled in config (otel)' };

      return { supported: true, configured: false, detail: read.state === 'invalid' ? 'settings unparseable' : 'no settings file' };
    }

    const envBlock = asRecord(settings[ENV_BLOCK_KEY]) ?? {};
    const ownedKeys = this.ownedKeys(context);

    if (disabled) return inspectDisabled(settings, envBlock, ownedKeys);

    const desired = desiredClaudeOtelEnv(context);

    if (!desired) return { supported: true, configured: false, detail: 'no backend endpoint configured' };

    if (Object.entries(desired).every(([key, value]) => envBlock[key] === value)) {
      return { supported: true, configured: true };
    }

    const conflicting = foreignKeys(envBlock, desired, ownedKeys);

    if (conflicting.length > 0) {
      return { supported: true, configured: false, conflict: `existing telemetry env vars: ${conflicting.join(', ')}` };
    }

    return { supported: true, configured: false };
  }

  /**
   * Write the telemetry configuration into Claude Code's settings.
   *
   * Refuses rather than overwrites when a telemetry variable is already set to
   * something we did not write: the user may be exporting to their own
   * collector, and silently redirecting that would be the worst possible
   * outcome of installing a telemetry edge.
   *
   * @param context - Environment, paths, config and install state.
   * @returns Whether the file changed, what to tell the user, and the next
   *   install state.
   */
  async configure(context: SetupContext): Promise<SetupOutcome> {
    const desired = desiredClaudeOtelEnv(context);

    if (!desired) return this.configureDisabled(context);

    const settingsPath = claudeSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);

    if (read.state === 'invalid') {
      return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
    }

    if (read.state === 'ok' && !asRecord(read.value)) {
      return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
    }

    const settings: UnknownRecord = (read.state === 'ok' ? asRecord(read.value) : undefined) ?? {};
    const envBlock = asRecord(settings[ENV_BLOCK_KEY]) ?? {};
    const ownedKeys = this.ownedKeys(context);
    const conflicting = foreignKeys(envBlock, desired, ownedKeys);

    if (conflicting.length > 0) {
      return {
        ok: false,
        changed: false,
        messages: [`skipping native OpenTelemetry: ${conflicting.join(', ')} already set in ${settingsPath} (not AgentWatch-owned)`]
      };
    }

    // Signals disabled since the previous run leave stale AgentWatch-owned keys
    // behind — the enhanced-telemetry flag, once traces go off.
    const stale = new Set(ownedKeys.filter((key) => key !== HEADERS_HELPER_KEY && desired[key] === undefined));
    const withEnv: UnknownRecord = { ...settings, [ENV_BLOCK_KEY]: { ...omitKeys(envBlock, stale), ...desired } };
    const helper = this.applyHeadersHelper(withEnv, context);

    if ('conflict' in helper) {
      return { ok: false, changed: false, messages: [helper.conflict] };
    }

    const changed = JSON.stringify(helper.settings) !== JSON.stringify(settings);

    if (changed) {
      await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
      await writeJsonValidated(settingsPath, helper.settings);
    }

    return {
      ok: true,
      changed,
      messages: changed
        ? [`native OpenTelemetry configured (signals: ${enabledSignalNames(context.config.otel).join(', ')})`, 'restart running Claude Code sessions to pick it up']
        : ['native OpenTelemetry already configured'],
      installState: withOtelInstall(context.installState, CLAUDE_PROVIDER_ID, {
        configPath: settingsPath,
        ownedKeys: [...Object.keys(desired), ...helper.ownedExtra],
        configuredAt: context.env.now()
      })
    };
  }

  /**
   * Remove the telemetry configuration AgentWatch wrote.
   *
   * Only our own keys go. Without a recorded key list we fall back to the
   * well-known ones, and then only when their values are the ones we would have
   * written — user-owned telemetry config is never removed.
   *
   * @param context - Environment, paths, config and install state.
   * @returns Whether the file changed, what to tell the user, and the next
   *   install state.
   */
  async uninstall(context: SetupContext): Promise<SetupOutcome> {
    const settingsPath = claudeSettingsPath(context.env);
    const read = await readJsonFile(settingsPath);

    if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Claude settings file'] };

    const settings = read.state === 'ok' ? asRecord(read.value) : undefined;

    if (!settings) return { ok: false, changed: false, messages: [`cannot parse ${settingsPath}; not modified`] };

    const desired = desiredClaudeOtelEnv(context) ?? {};
    const recorded = this.ownedKeys(context);
    const envBlock = asRecord(settings[ENV_BLOCK_KEY]);
    const removable = removableEnvKeys(envBlock, recorded, desired);
    const helperRemoved = isOurHelper(settings[HEADERS_HELPER_KEY]);
    const changed = removable.size > 0 || helperRemoved;

    if (changed) {
      await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
      await writeJsonValidated(settingsPath, strippedSettings(settings, envBlock, removable, helperRemoved));
    }

    return {
      ok: true,
      changed,
      messages: changed ? ['native OpenTelemetry configuration removed'] : ['no AgentWatch telemetry configuration found'],
      installState: withoutOtelInstall(context.installState, CLAUDE_PROVIDER_ID)
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

    // Deliberately off: the desired state is "no AgentWatch telemetry", which
    // means removing whatever a previous setup left behind.
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

  /**
   * Add the header-helper command when a token needs one.
   *
   * @param settings - Settings with the env block already updated.
   * @param context - Environment, paths, config and install state.
   * @returns The next settings and the extra owned key, or a conflict message.
   */
  private applyHeadersHelper(
    settings: UnknownRecord,
    context: SetupContext
  ): { settings: UnknownRecord; ownedExtra: string[] } | { conflict: string } {
    if (!context.config.token) return { settings, ownedExtra: [] };

    const helperCommand = headersHelperCommand(context.hookCommand);
    const existing = settings[HEADERS_HELPER_KEY];

    if (typeof existing === 'string' && !existing.includes(HOOK_COMMAND_MARKER) && existing !== helperCommand) {
      return { conflict: `skipping native OpenTelemetry: ${HEADERS_HELPER_KEY} already set to a non-AgentWatch helper` };
    }

    return { settings: { ...settings, [HEADERS_HELPER_KEY]: helperCommand }, ownedExtra: [HEADERS_HELPER_KEY] };
  }

  /**
   * Settings keys a previous AgentWatch setup recorded as its own.
   *
   * @param context - Install state carrier.
   * @returns The recorded keys.
   */
  private ownedKeys(context: SetupContext): string[] {
    return context.installState.agents[CLAUDE_PROVIDER_ID]?.otelOwnedKeys ?? [];
  }
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
  const leftover = ownedKeys.some((key) => (key === HEADERS_HELPER_KEY ? settings[key] !== undefined : envBlock[key] !== undefined));

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
 * Env keys uninstall is allowed to remove.
 *
 * @param envBlock - Current env block, when there is one.
 * @param recorded - Keys a previous setup recorded as ours.
 * @param desired - What this config would write, for the value check.
 * @returns The keys to drop.
 */
function removableEnvKeys(envBlock: UnknownRecord | undefined, recorded: readonly string[], desired: Record<string, string>): Set<string> {
  const removable = new Set<string>();

  if (!envBlock) return removable;

  const candidates = recorded.length > 0 ? recorded : Object.keys(desired);

  for (const key of candidates) {
    if (key === HEADERS_HELPER_KEY || envBlock[key] === undefined) continue;

    // Without a recorded list we are guessing, so a value we would not have
    // written belongs to the user and stays.
    if (recorded.length === 0 && desired[key] !== undefined && envBlock[key] !== desired[key]) continue;

    removable.add(key);
  }

  return removable;
}

/**
 * Settings with our telemetry keys removed.
 *
 * @param settings - The whole settings object.
 * @param envBlock - Its env block, when there is one.
 * @param removable - Env keys to drop.
 * @param helperRemoved - Whether the header helper is ours to drop.
 * @returns The next settings object.
 */
function strippedSettings(
  settings: UnknownRecord,
  envBlock: UnknownRecord | undefined,
  removable: ReadonlySet<string>,
  helperRemoved: boolean
): UnknownRecord {
  const withoutHelper = helperRemoved ? omitKeys(settings, new Set([HEADERS_HELPER_KEY])) : settings;

  if (!envBlock) return withoutHelper;

  const nextEnv = omitKeys(envBlock, removable);

  // An emptied env block is dropped rather than left as `"env": {}`.
  if (Object.keys(nextEnv).length === 0) return omitKeys(withoutHelper, new Set([ENV_BLOCK_KEY]));

  return { ...withoutHelper, [ENV_BLOCK_KEY]: nextEnv };
}

/**
 * Whether the configured header helper is one we wrote.
 *
 * @param helper - Current value of the helper key.
 * @returns True when it is ours.
 */
function isOurHelper(helper: unknown): boolean {
  return typeof helper === 'string' && helper.includes(HOOK_COMMAND_MARKER);
}
