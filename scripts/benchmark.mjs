import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { EventQueue } from '../dist/transport/queue.js';

// Fresh CLI processes and a real filesystem, with no external backend or real
// agent configuration. Report distributions; shared CI hardware is not a stable
// absolute-latency gate. Queue correctness remains asserted in the test suite.
const samples = Number(process.env.AGENTWATCH_BENCH_SAMPLES ?? 30);
assert(Number.isInteger(samples) && samples >= 5 && samples <= 1000, 'AGENTWATCH_BENCH_SAMPLES must be an integer from 5 to 1000');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'agentwatch-benchmark-'));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const results = [];

try {
  const configDir = path.join(scratch, 'config');
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    developerEmail: 'benchmark@example.invalid',
    enforcement: { enabled: false },
    capture: { git: false, files: false }
  }));
  const env = {
    ...process.env,
    HOME: scratch,
    USERPROFILE: scratch,
    AGENTWATCH_CONFIG_DIR: configDir,
    AGENTWATCH_DATA_DIR: dataDir,
    AGENTWATCH_TOKEN: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(scratch, 'absent-gitconfig')
  };
  const invoke = () => {
    const child = spawnSync(process.execPath, [cli, 'hook', '--agent', 'claude'], {
      cwd: scratch,
      env,
      input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'benchmark', cwd: scratch, tool_name: 'Read', tool_input: { file_path: 'example.txt' }, tool_response: 'benchmark' }),
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
  };
  // Warm the filesystem, but every measured invocation still starts a fresh Node.
  invoke();
  results.push(await measure('fresh CLI / PostToolUse / no backend', invoke));

  for (const count of [0, 100, 2000]) {
    const queueDir = path.join(scratch, `queue-${count}`);
    const queue = new EventQueue({ queueDir, locksDir: path.join(scratch, `locks-${count}`), maxEvents: 2000, maxAttempts: 20, maxEventAgeDays: 7 });
    await fs.mkdir(queueDir);
    const at = new Date().toISOString();
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    for (let index = 0; index < count; index++) {
      const event = { id: `event-${index}`, event: { type: 'turn.summary' } };
      await fs.writeFile(path.join(queueDir, `${event.id}.json`), JSON.stringify({ event, attempts: 0, firstQueuedAt: at, nextAttemptAt: later, destination: 'https://benchmark.example.invalid/v1/events' }));
    }
    let sendCalls = 0;
    const transport = { destination: 'https://benchmark.example.invalid/v1/events', send: async () => { sendCalls++; throw new Error('Backoff entries must not send'); } };
    // Measure maintenance separately: the bounded scan does not include the
    // hourly full-partition sweep, and the report must not hide that cost.
    const sweepStart = performance.now();
    await queue.sweep();
    const sweepMs = performance.now() - sweepStart;
    const scan = await measure(`queue / ${count} entries in backoff / batch 25`, () => queue.drain(transport, 25));
    assert.equal(sendCalls, 0, 'Backoff entries must not send');
    assert.equal(await queue.pendingCount(), count);
    results.push({ ...scan, initialSweepMs: round(sweepMs) });
  }
  console.log(JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    samples,
    notes: 'Milliseconds; warm filesystem; fresh process for each CLI sample. Queue scans exclude the separately reported initial full sweep. No external network. p99 is descriptive at this sample size.',
    results
  }, null, 2));
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}

async function measure(name, operation) {
  const timings = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    await operation();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const percentile = (fraction) => round(timings[Math.ceil(timings.length * fraction) - 1]);
  return { name, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: round(timings.at(-1)) };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
