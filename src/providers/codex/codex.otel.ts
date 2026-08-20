import fs from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { asRecord } from '../../core/object.js';
import type { Env, UnknownRecord } from '../../core/types/core.types.js';
import { joinUrl, otlpBaseUrl } from '../../config/config.js';
import type { AgentWatchConfig, OtelConfig } from '../../config/types/config.types.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { SECRET_FILE_MODE } from '../../storage/constants/storage.constants.js';
import { withOtelInstall, withoutOtelInstall } from '../shared/install-record.js';
import type { NativeTelemetryConfigurator, NativeTelemetryStatus, SetupContext, SetupOutcome } from '../types/provider.types.js';
import { codexConfigTomlPath } from './codex.detect.js';
import { CODEX_PROVIDER_ID } from './constants/codex.constants.js';
import {
  BLOCK_END,
  BLOCK_START,
  CODEX_OTEL_SIGNALS,
  LOGS_PATH,
  OTEL_TABLE_KEY,
  RE_LEADING_NEWLINE,
  RE_TOML_BACKSLASH,
  RE_TOML_QUOTE,
  RE_TRAILING_NEWLINES,
  TRACES_PATH
} from './constants/codex.otel.constants.js';

/**
 * Configures Codex's own OTLP export.
 *
 * Logs give one `response.completed` / `codex.api_request` usage record per
 * provider request; traces carry thread.id, turn.id and multi-agent linkage.
 * The backend normalizes both into llm.call.
 */
export class CodexOtelConfigurator implements NativeTelemetryConfigurator {
  /**
   * Whether this agent can export native telemetry at all.
   *
   * @param _env - Unused; Codex always supports it.
   * @returns Always true.
   */
  async supported(_env: Env): Promise<boolean> {
    return true;
  }

  /**
   * Report whether the machine's telemetry configuration matches what we want.
   *
   * @param context - Environment, paths and config.
   * @returns The status, naming any foreign configuration in the way.
   */
  async inspect(context: SetupContext): Promise<NativeTelemetryStatus> {
    const disabled = !codexOtelEnabled(context.config);
    const raw = await readFileOrUndefined(codexConfigTomlPath(context.env));

    if (raw === undefined) {
      if (disabled) return { supported: true, configured: true, detail: 'disabled in config (otel)' };

      return { supported: true, configured: false, detail: 'no config.toml' };
    }

    const hasBlock = raw.includes(BLOCK_START);

    if (disabled) return inspectDisabled(hasBlock);

    if (hasBlock) return inspectManagedBlock(raw, context.config);

    const parsed = tryParseToml(raw);

    if (parsed === undefined) return { supported: true, configured: false, detail: 'config.toml unparseable' };

    if (parsed[OTEL_TABLE_KEY] !== undefined) {
      return { supported: true, configured: false, conflict: 'an [otel] section not owned by AgentWatch already exists' };
    }

    return { supported: true, configured: false };
  }

  /**
   * Write the managed `[otel]` block into Codex's config.toml.
   *
   * @param context - Environment, paths, config and install state.
   * @returns Whether the file changed, what to tell the user, and the next
   *   install state.
   */
  async configure(context: SetupContext): Promise<SetupOutcome> {
    if (!codexOtelEnabled(context.config)) return this.configureDisabled(context);

    const otlpBase = otlpBaseUrl(context.config);

    if (!otlpBase) return { ok: false, changed: false, messages: ['no backend endpoint configured'] };

    const configPath = codexConfigTomlPath(context.env);
    const raw = (await readFileOrUndefined(configPath)) ?? '';
    const block = renderBlock(otlpBase, context.config.token, context.config.otel);
    const next = raw.includes(BLOCK_START) ? replaceBlock(raw, block) : appendBlock(raw, block);

    if (typeof next !== 'string') return { ok: false, changed: false, messages: [next.error(configPath)] };

    if (next === raw) return { ok: true, changed: false, messages: ['native OpenTelemetry already configured'] };

    // Belt and braces: a generated file the agent cannot parse would disable
    // every other setting in it, not just telemetry.
    if (tryParseToml(next) === undefined) {
      return { ok: false, changed: false, messages: ['internal error: generated config.toml would not parse; nothing written'] };
    }

    await backupFile(configPath, context.paths.backupsDir, context.env.now());
    // The managed block may carry the bearer token, so the file becomes private.
    await writeFileAtomic(configPath, next, context.config.token ? SECRET_FILE_MODE : undefined);

    return {
      ok: true,
      changed: true,
      messages: [`native OpenTelemetry configured (signals: ${codexSignalNames(context.config.otel).join(', ')})`, 'restart running Codex sessions to pick it up'],
      installState: withOtelInstall(context.installState, CODEX_PROVIDER_ID, {
        configPath,
        ownedKeys: [OTEL_TABLE_KEY],
        configuredAt: context.env.now()
      })
    };
  }

  /**
   * Remove the managed block from Codex's config.toml.
   *
   * Only the marker-delimited region goes; everything the developer wrote
   * around it — comments included — is preserved byte for byte.
   *
   * @param context - Environment, paths and install state.
   * @returns Whether the file changed, what to tell the user, and the next
   *   install state.
   */
  async uninstall(context: SetupContext): Promise<SetupOutcome> {
    const configPath = codexConfigTomlPath(context.env);
    const raw = await readFileOrUndefined(configPath);

    if (raw === undefined || !raw.includes(BLOCK_START)) {
      return { ok: true, changed: false, messages: ['no AgentWatch telemetry configuration found'] };
    }

    const next = replaceBlock(raw, undefined);

    if (typeof next !== 'string') return { ok: false, changed: false, messages: [next.error(configPath)] };

    await backupFile(configPath, context.paths.backupsDir, context.env.now());
    await writeFileAtomic(configPath, next);

    return {
      ok: true,
      changed: true,
      messages: ['native OpenTelemetry configuration removed'],
      installState: withoutOtelInstall(context.installState, CODEX_PROVIDER_ID)
    };
  }

  /**
   * Handle `configure` when Codex telemetry is deliberately off.
   *
   * @param context - Environment, paths and install state.
   * @returns The outcome.
   */
  private async configureDisabled(context: SetupContext): Promise<SetupOutcome> {
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

/** A refusal, carrying the message to show once the path is known. */
interface BlockFailure {
  readonly error: (configPath: string) => string;
}

/**
 * Whether Codex has any signal to export.
 *
 * Codex exports logs and traces only; `otel.metrics` has no effect here.
 *
 * @param config - Effective configuration.
 * @returns True when logs or traces are on.
 */
function codexOtelEnabled(config: AgentWatchConfig): boolean {
  return config.otel.logs || config.otel.traces;
}

/**
 * Names of the Codex-relevant signals that are on.
 *
 * @param signals - The signal selection.
 * @returns Enabled signal names.
 */
function codexSignalNames(signals: OtelConfig): string[] {
  return CODEX_OTEL_SIGNALS.filter((name) => signals[name]);
}

/**
 * Status when Codex telemetry is deliberately off.
 *
 * @param hasBlock - Whether our managed block is still in the file.
 * @returns Configured, unless our leftovers are still there.
 */
function inspectDisabled(hasBlock: boolean): NativeTelemetryStatus {
  if (!hasBlock) return { supported: true, configured: true, detail: 'disabled in config (otel)' };

  return {
    supported: true,
    configured: false,
    detail: 'disabled in config, but the AgentWatch [otel] block remains — run `agentwatch setup`'
  };
}

/**
 * Status when our managed block is present: does it say what it should?
 *
 * @param raw - The whole config.toml.
 * @param config - Effective configuration.
 * @returns The status.
 */
function inspectManagedBlock(raw: string, config: AgentWatchConfig): NativeTelemetryStatus {
  const otlpBase = otlpBaseUrl(config);

  if (!otlpBase) return { supported: true, configured: false, detail: 'no backend endpoint configured' };

  const actual = extractBlock(raw);
  const expected = renderBlock(otlpBase, config.token, config.otel).trim();

  if (actual === expected) return { supported: true, configured: true };

  return { supported: true, configured: false, detail: 'AgentWatch [otel] block is incomplete or stale — run `agentwatch setup`' };
}

/**
 * The managed block, rendered for this configuration.
 *
 * A disabled signal is written as an explicit `"none"` rather than omitted, so
 * an ambient default can never re-enable it.
 *
 * @param otlpBase - Backend OTLP base URL.
 * @param token - Bearer token, when one is configured.
 * @param signals - The signal selection.
 * @returns The block text, newline-terminated.
 */
function renderBlock(otlpBase: string, token: string | undefined, signals: OtelConfig): string {
  const headers = token ? `, headers = { "Authorization" = "Bearer ${escapeTomlString(token)}" }` : '';

  return [
    BLOCK_START,
    `[${OTEL_TABLE_KEY}]`,
    signals.logs
      ? `exporter = { otlp-http = { endpoint = "${escapeTomlString(joinUrl(otlpBase, LOGS_PATH))}", protocol = "json"${headers} } }`
      : 'exporter = "none"',
    signals.traces
      ? `trace_exporter = { otlp-http = { endpoint = "${escapeTomlString(joinUrl(otlpBase, TRACES_PATH))}", protocol = "json"${headers} } }`
      : 'trace_exporter = "none"',
    // Codex has no useful OTLP metrics; off regardless of otel.metrics.
    'metrics_exporter = "none"',
    BLOCK_END,
    ''
  ].join('\n');
}

/**
 * Replace, or remove, the marker-delimited block.
 *
 * @param raw - The whole config.toml.
 * @param block - The new block, or undefined to remove it.
 * @returns The next contents, or a failure when the markers are malformed.
 */
function replaceBlock(raw: string, block: string | undefined): string | BlockFailure {
  const bounds = blockBounds(raw);

  if (!bounds) return malformedMarkers;

  const head = raw.slice(0, bounds.start);
  const tail = raw.slice(bounds.end).replace(RE_LEADING_NEWLINE, '');

  if (block === undefined) return head.replace(RE_TRAILING_NEWLINES, '\n') + tail;

  return head + block + tail;
}

/**
 * Append the managed block to a config that has none.
 *
 * @param raw - The whole config.toml, possibly empty.
 * @param block - The block to add.
 * @returns The next contents, or a failure when the file cannot be touched.
 */
function appendBlock(raw: string, block: string): string | BlockFailure {
  const parsed = tryParseToml(raw);

  if (raw.trim() !== '' && parsed === undefined) return unparseableConfig;

  if (parsed?.[OTEL_TABLE_KEY] !== undefined) return foreignOtelTable;

  const separator = raw === '' || raw.endsWith('\n') ? '' : '\n';
  const blankLine = raw.trim() === '' ? '' : '\n';

  return raw + separator + blankLine + block;
}

/**
 * Our block's boundaries inside the file.
 *
 * @param raw - The whole config.toml.
 * @returns The start and end offsets, or undefined when the markers are broken.
 */
function blockBounds(raw: string): { start: number; end: number } | undefined {
  const start = raw.indexOf(BLOCK_START);
  const endMarker = raw.indexOf(BLOCK_END);

  if (start === -1 || endMarker === -1 || endMarker < start) return undefined;

  return { start, end: endMarker + BLOCK_END.length };
}

/**
 * The managed block as it currently stands in the file.
 *
 * @param raw - The whole config.toml.
 * @returns The block text, or undefined when the markers are broken.
 */
function extractBlock(raw: string): string | undefined {
  const bounds = blockBounds(raw);

  if (!bounds) return undefined;

  return raw.slice(bounds.start, bounds.end).trim();
}

/**
 * Escape a string for a TOML basic-string literal.
 *
 * @param value - Raw value, possibly a token.
 * @returns The escaped form.
 */
function escapeTomlString(value: string): string {
  return value.replace(RE_TOML_BACKSLASH, '\\\\').replace(RE_TOML_QUOTE, '\\"');
}

/**
 * Read a file, treating any failure as "not there".
 *
 * @param filePath - File to read.
 * @returns Its contents, or undefined.
 */
async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Parse TOML, treating any failure as unparseable.
 *
 * @param raw - TOML text.
 * @returns The parsed table, or undefined.
 */
function tryParseToml(raw: string): UnknownRecord | undefined {
  try {
    return asRecord(parseToml(raw));
  } catch {
    return undefined;
  }
}

const malformedMarkers: BlockFailure = { error: (configPath) => `malformed AgentWatch block markers in ${configPath}; fix manually` };
const unparseableConfig: BlockFailure = { error: (configPath) => `refusing to modify unparseable ${configPath}` };
const foreignOtelTable: BlockFailure = {
  error: (configPath) => `skipping native OpenTelemetry: ${configPath} already has an [otel] section (not AgentWatch-owned)`
};
