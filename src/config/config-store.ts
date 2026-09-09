import crypto from 'node:crypto';
import { asRecord } from '../core/object.js';
import { readJsonFile } from '../storage/json-file.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';
import type { AgentWatchPaths } from '../storage/types/storage.types.js';
import { CONTENT_CAPTURE_KEYS, DELIVERABLE_URL_MESSAGE } from './constants/config.constants.js';
import { defaultConfig } from './config.js';
import { configSchema, nonDeliverableUrlFields } from './schemas/config.schema.js';
import type { AgentWatchConfig, CaptureConfig, ConfigLoadResult } from './types/config.types.js';

export type { ConfigLoadResult } from './types/config.types.js';

/**
 * Read the global config.
 *
 * Never throws and never returns without a usable config: hooks run inside the
 * coding agent, and a broken config file must degrade behaviour, not break the
 * agent. The caller distinguishes the three outcomes to decide what to *say*
 * about it.
 *
 * @param paths - Resolved AgentWatch paths.
 * @returns The load state and a config to run with.
 */
export async function loadConfig(paths: AgentWatchPaths): Promise<ConfigLoadResult> {
  const result = await readJsonFile(paths.configFile);

  if (result.state === 'missing') return { state: 'missing', config: fallbackConfig(), warnings: [] };

  if (result.state === 'invalid') return { state: 'invalid', error: result.error, config: fallbackConfig(), warnings: [] };

  // The schema drops a URL the edge refuses to talk to rather than failing the
  // whole file — see `deliverableUrl`. What it cannot do is say so, because by
  // then the field is gone, so the raw value is asked instead. Every caller
  // reports these: the hook path on stderr, `doctor` and `status` by name.
  const warnings = nonDeliverableUrlFields(result.value).map((field) => `${field}: ${DELIVERABLE_URL_MESSAGE} — ignored, nothing is sent there`);
  const parsed = configSchema.safeParse(result.value);

  if (!parsed.success) return { state: 'invalid', error: describeIssues(parsed.error.issues), config: fallbackConfig(), warnings };

  return { state: 'ok', config: parsed.data, warnings };
}

/**
 * Persist the global config atomically.
 *
 * @param paths - Resolved AgentWatch paths.
 * @param config - Config to write.
 */
export async function saveConfig(paths: AgentWatchPaths, config: AgentWatchConfig): Promise<void> {
  // Write the flags the user chose, not the flags the consent gate computed.
  // `loadConfig` re-applies the gate on every read, so persisting the gated
  // shape would change nothing at runtime and would quietly erase the choice:
  // a machine that later adds `contentCaptureConsent: true` would find every
  // content flag already false and no record that it had ever set them.
  const capture = { ...config.capture, ...(await storedCapture(paths)) };

  // 0600: the file may contain a backend token.
  await writeFileAtomic(paths.configFile, JSON.stringify({ ...config, capture }, null, 2) + '\n', SECRET_FILE_MODE);
}

/**
 * The content flags as they are written on disk right now.
 *
 * Read raw rather than through the schema: the schema is where the gate lives,
 * so a parsed value has already lost the distinction this exists to keep.
 * Only the four content flags are carried over — a metadata flag the caller
 * changed is a change the caller meant.
 *
 * @param paths - Resolved AgentWatch paths.
 * @returns The stored content flags; empty when the file has none.
 */
async function storedCapture(paths: AgentWatchPaths): Promise<Partial<CaptureConfig>> {
  const result = await readJsonFile(paths.configFile);

  if (result.state !== 'ok') return {};

  const capture = asRecord(asRecord(result.value)?.['capture']);

  if (!capture) return {};

  const out: Record<string, boolean> = {};

  for (const key of CONTENT_CAPTURE_KEYS) {
    if (typeof capture[key] === 'boolean') out[key] = capture[key];
  }

  return out as Partial<CaptureConfig>;
}

/**
 * The config with an installation id, generating one on first use.
 *
 * @param config - Config to complete.
 * @returns The same config, or a copy carrying a fresh id.
 */
export function ensureInstallationId(config: AgentWatchConfig): AgentWatchConfig {
  if (config.installationId) return config;

  return { ...config, installationId: crypto.randomUUID() };
}

/**
 * Fail-safe runtime config for a missing or corrupt file.
 *
 * Hooks keep running, but content capture is OFF: an accidental config wipe
 * must not silently start collecting prompts and tool I/O. The schema defaults
 * are already off, so this now only pins the guarantee — deliberately, so that
 * a future default cannot quietly widen what a *broken* config collects.
 *
 * @returns A metadata-only config.
 */
function fallbackConfig(): AgentWatchConfig {
  const config = defaultConfig();

  return {
    ...config,
    capture: { ...config.capture, prompts: false, responses: false, toolInput: false, toolOutput: false }
  };
}

/**
 * Render schema issues as one human-readable line.
 *
 * @param issues - Zod issues from a failed parse.
 * @returns The joined description.
 */
function describeIssues(issues: readonly { path: (string | number)[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}
