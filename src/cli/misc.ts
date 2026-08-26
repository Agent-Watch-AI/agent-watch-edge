import process from 'node:process';
import { loadEffectiveConfig } from '../config/repo-config.js';
import type { Env } from '../core/types/core.types.js';
import { providers } from '../providers/registry.js';
import { buildCliContext } from './context.js';
import { REDACTED_TOKEN } from './constants/cli.constants.js';
import { bold, dim, println, symbols } from './ui.js';

/**
 * `agentwatch agents` — detection details for debugging.
 *
 * @param env - Ambient environment.
 * @returns Exit code 0; detection is informational.
 */
export async function runAgents(env: Env): Promise<number> {
  for (const provider of providers) {
    const detection = await provider.detect(env);

    println(bold(`${provider.displayName} (${provider.id})`));
    println(`${detection.detected ? symbols.ok : symbols.off} ${detection.detected ? 'detected' : 'not detected'}`);

    for (const evidence of detection.evidence) println(dim(`  - ${evidence}`));

    println(dim(`  hook config: ${detection.hookConfigPath}`));
    println(dim(`  hooks installed: ${detection.hooksInstalled ? 'yes' : 'no'}`));
    println();
  }

  return 0;
}

/**
 * `agentwatch config` — the effective configuration for this directory, with
 * the token redacted.
 *
 * Effective, not global: what hooks actually do here is the global file plus the
 * repository overlay, and showing only the former would answer the wrong
 * question.
 *
 * @param env - Ambient environment.
 * @returns 1 when the global config is invalid, else 0.
 */
export async function runConfig(env: Env): Promise<number> {
  const context = await buildCliContext(env);

  println(dim(`# global: ${context.paths.configFile} (${context.configState})`));

  const effective = await loadEffectiveConfig(context.paths, env.cwd);

  if (effective.rootPath) println(dim(`# project root: ${effective.rootPath}`));

  if (effective.repoConfigFile) println(dim(`# repo overrides: ${effective.repoConfigFile}`));

  for (const warning of effective.warnings) println(dim(`# warning: ${warning}`));

  println(JSON.stringify({ ...effective.config, token: effective.config.token ? REDACTED_TOKEN : undefined }, null, 2));

  return context.configState === 'invalid' ? 1 : 0;
}

/**
 * `agentwatch otel-headers` — Claude Code's otelHeadersHelper contract.
 *
 * Print a JSON object of OTLP headers on stdout and nothing else: this is how
 * the bearer token reaches the exporter without ever being written into Claude's
 * settings file.
 *
 * @param env - Ambient environment.
 * @returns Exit code 0.
 */
export async function runOtelHeaders(env: Env): Promise<number> {
  const context = await buildCliContext(env);
  // Effective, not global: with two tenants on one machine the token that
  // signs this export is decided by the directory the agent is running in.
  const effective = await loadEffectiveConfig(context.paths, env.cwd);
  const headers = effective.config.token ? { Authorization: `Bearer ${effective.config.token}` } : {};

  process.stdout.write(JSON.stringify(headers));

  return 0;
}
