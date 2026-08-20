import { z } from 'zod';

/**
 * Records exactly what `agentwatch setup` wrote into one agent's native
 * configuration, so uninstall removes only AgentWatch-owned entries.
 *
 * Passthrough: a state file written by a newer version must survive a
 * downgrade with its unknown fields intact.
 */
export const agentInstallSchema = z
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

/** The whole install-state file: one entry per agent. */
export const installStateSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    agents: z.record(agentInstallSchema).default({})
  })
  .passthrough();
