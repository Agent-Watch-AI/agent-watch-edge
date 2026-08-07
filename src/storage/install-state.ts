import { z } from 'zod';
import { readJsonFile } from './json-file.js';
import { writeFileAtomic } from './atomic-file.js';
import type { AgentWatchPaths } from './paths.js';

/**
 * Records exactly what `agentwatch setup` wrote into each agent's native
 * configuration, so uninstall removes only AgentWatch-owned entries.
 */
const agentInstallSchema = z
  .object({
    hooksInstalledAt: z.string().optional(),
    hookConfigPath: z.string().optional(),
    hookEvents: z.array(z.string()).default([]),
    hookCommand: z.string().optional(),
    otelConfiguredAt: z.string().optional(),
    otelConfigPath: z.string().optional(),
    otelOwnedKeys: z.array(z.string()).default([]),
    notes: z.array(z.string()).default([])
  })
  .passthrough();

const installStateSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    agents: z.record(agentInstallSchema).default({})
  })
  .passthrough();

export type AgentInstallState = z.infer<typeof agentInstallSchema>;
export type InstallState = z.infer<typeof installStateSchema>;

export async function loadInstallState(paths: AgentWatchPaths): Promise<InstallState> {
  const result = await readJsonFile(paths.installStateFile);
  if (result.state === 'ok') {
    const parsed = installStateSchema.safeParse(result.value);
    if (parsed.success) return parsed.data;
  }
  return { schemaVersion: 1, agents: {} };
}

export async function saveInstallState(paths: AgentWatchPaths, state: InstallState): Promise<void> {
  await writeFileAtomic(paths.installStateFile, JSON.stringify(state, null, 2) + '\n', 0o600);
}
