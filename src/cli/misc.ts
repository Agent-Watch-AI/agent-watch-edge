import process from 'node:process';
import { eventsUrl, otlpBaseUrl } from '../config/config.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { applyRootOverride } from '../config/root-config.js';
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
  println(`# AgentWatch ${context.disabled ? 'DISABLED' : 'enabled'}`);

  const effective = await loadEffectiveConfig(context.paths, env.cwd);

  if (effective.rootPath) println(dim(`# project root: ${effective.rootPath}`));

  if (effective.repoConfigFile) println(dim(`# repo overrides: ${effective.repoConfigFile}`));

  if (effective.rootPath && !eventsUrl(effective.config)) println(dim('# warning: this project root has no usable events route; events stay queued — configure its endpoint/eventsUrl or fix the refused URL'));

  if (effective.rootPath && !otlpBaseUrl(effective.config)) println(dim('# warning: this project root has no usable OTLP route; the machine collector is not inherited'));

  for (const warning of [...context.configWarnings, ...effective.warnings]) println(dim(`# warning: ${warning}`));

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
  // Per directory, not machine-wide: with two tenants on one machine the token
  // that signs this export is decided by where the agent is running. Roots are
  // all that can move identity (a repo file cannot), so the global config
  // already in hand is enough. But the agent exports to the machine-wide
  // collector, so a root enrolled against a different backend gets no bearer
  // at all rather than presenting its credential to the other tenant's collector.
  const rooted = applyRootOverride(context.config, env.cwd).config;
  // `Boolean(base)`: two undefined bases compare equal, so the guard used to
  // open precisely when neither side has a collector to export to — a refused
  // machine endpoint and a root with one of its own printed the root's bearer
  // for nobody.
  const base = otlpBaseUrl(rooted);
  const token = Boolean(base) && base === otlpBaseUrl(context.config) ? rooted.token : undefined;
  const headers = !context.disabled && token ? { Authorization: `Bearer ${token}` } : {};

  process.stdout.write(JSON.stringify(headers));

  return 0;
}
