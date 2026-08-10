import process from 'node:process';
import type { Env } from '../core/env.js';
import { providers } from '../providers/registry.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { buildCliContext } from './context.js';
import { bold, dim, println, symbols } from './ui.js';

/** `agentwatch agents` — detection details for debugging. */
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

/** `agentwatch config` — sanitized configuration dump. */
export async function runConfig(env: Env): Promise<number> {
  const context = await buildCliContext(env);
  println(dim(`# global: ${context.paths.configFile} (${context.configState})`));
  const effective = await loadEffectiveConfig(context.paths, env.cwd);
  if (effective.repoConfigFile) {
    println(dim(`# repo overrides: ${effective.repoConfigFile}`));
  }
  for (const warning of effective.warnings) println(dim(`# warning: ${warning}`));
  const sanitized = { ...effective.config, token: effective.config.token ? '<redacted>' : undefined };
  println(JSON.stringify(sanitized, null, 2));
  return context.configState === 'invalid' ? 1 : 0;
}

/**
 * `agentwatch otel-headers` — Claude Code's otelHeadersHelper contract:
 * print a JSON object of OTLP headers on stdout and nothing else.
 */
export async function runOtelHeaders(env: Env): Promise<number> {
  const context = await buildCliContext(env);
  const headers: Record<string, string> = {};
  if (context.config.token) headers['Authorization'] = `Bearer ${context.config.token}`;
  process.stdout.write(JSON.stringify(headers));
  return 0;
}
