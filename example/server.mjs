#!/usr/bin/env node
/**
 * Example AgentWatch backend: a zero-dependency Node.js server that accepts
 * everything the Bridge and the agents' native OpenTelemetry send, and logs
 * it to the console. For local testing only.
 *
 *   npm run example              # listens on http://127.0.0.1:8787
 *   PORT=9000 npm run example
 *   JSON=1 npm run example       # also print each event as full JSON
 *
 * Endpoints:
 *   POST /v1/events               turn.summary records (JSON)
 *   POST /v1/otlp/v1/metrics
 *   POST /v1/otlp/v1/logs
 *   POST /v1/otlp/v1/traces
 *   GET  /                        health check
 */
import http from 'node:http';
import { normalizeOtlpLogs } from '../dist/otlp/normalize.js';

const PORT = Number(process.env.PORT ?? 8787);
const PRINT_JSON = process.env.JSON === '1';
const isTTY = process.stdout.isTTY;
const paint = (code, text) => (isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (text) => paint('90', text);
const timestamp = () => new Date().toISOString().slice(11, 23);

let eventCount = 0;
let otlpCount = 0;
let llmCallCount = 0;

function log(tag, tagColor, message) {
  console.log(`${dim(timestamp())} ${paint(tagColor, tag.padEnd(8))} ${message}`);
}

function shortId(id) {
  return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : (id ?? '-');
}

function describeEvent(event) {
  const parts = [
    paint('36', (event.agent?.provider ?? '?').padEnd(6)),
    paint('1', (event.event?.type ?? '?').padEnd(20)),
    dim(`session=${shortId(event.session?.id)}`)
  ];
  if (event.tool?.name) parts.push(`tool=${event.tool.name}`);
  if (event.metadata?.filePath) parts.push(`file=${event.metadata.filePath}`);
  if (event.metadata?.command) parts.push(`cmd=${JSON.stringify(event.metadata.command)}`);
  const model = event.ai?.model ?? event.model;
  if (model) parts.push(`model=${model}`);
  const billing = event.ai?.billingMode ?? event.billing_mode;
  if (billing) parts.push(paint('35', billing));
  const usage = event.ai?.usage ?? (event.output_tokens !== undefined ? { inputTokens: event.input_tokens, outputTokens: event.output_tokens, cachedInputTokens: event.cached_input_tokens } : undefined);
  if (usage?.outputTokens !== undefined) {
    const cached = usage.cachedInputTokens !== undefined ? ` cached=${usage.cachedInputTokens}` : '';
    parts.push(paint('33', `tokens[in=${usage.inputTokens ?? 0} out=${usage.outputTokens}${cached}]`));
  }
  if (event.git?.branch) parts.push(dim(`${event.git.repository ?? ''}@${event.git.branch}`));
  if (event.feature?.candidates?.length) parts.push(paint('33', `ticket=${event.feature.candidates.map((c) => c.value).join(',')}`));
  return parts.join(' ');
}

/** Pull readable metric/event names out of an OTLP protobuf body (demo aid). */
function sniffOtlpNames(body) {
  const text = body.toString('latin1');
  const names = new Set();
  for (const match of text.matchAll(/(?:claude_code|codex|gen_ai)[.\w]+/g)) {
    names.add(match[0]);
    if (names.size >= 8) break;
  }
  return [...names];
}

/** Flatten OTLP JSON KeyValue attributes into a plain object. */
function otlpAttributes(list) {
  const out = {};
  for (const { key, value } of list ?? []) {
    if (!value) continue;
    out[key] = value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? undefined;
  }
  return out;
}

/** One readable line per OTLP JSON log record / metric (demo aid). */
function describeOtlpJson(signal, payload) {
  const lines = [];
  if (signal === 'logs') {
    for (const resource of payload.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          const attrs = otlpAttributes(record.attributes);
          const name = attrs['event.name'] ?? record.body?.stringValue ?? 'log';
          const parts = [paint('1', String(name).padEnd(28))];
          if (attrs['session.id']) parts.push(dim(`session=${shortId(attrs['session.id'])}`));
          if (attrs['model']) parts.push(`model=${attrs['model']}`);
          const tokens = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']
            .filter((key) => attrs[key] !== undefined)
            .map((key) => `${key.replace('_tokens', '')}=${attrs[key]}`);
          if (tokens.length > 0) parts.push(paint('33', `tokens[${tokens.join(' ')}]`));
          if (attrs['cost_usd'] !== undefined) parts.push(paint('32', `$${Number(attrs['cost_usd']).toFixed(6)}`));
          lines.push(parts.join(' '));
        }
      }
    }
  }
  if (signal === 'metrics') {
    for (const resource of payload.resourceMetrics ?? []) {
      for (const scope of resource.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? metric.histogram?.dataPoints ?? [];
          lines.push(`${paint('1', String(metric.name ?? 'metric').padEnd(28))} ${dim(`${points.length} datapoint(s)`)}`);
        }
      }
    }
  }
  return lines;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const url = (req.url ?? '/').split('?')[0];
  const auth = req.headers.authorization ? dim(' auth=bearer') : '';

  if (req.method === 'POST' && url === '/v1/events') {
    try {
      const payload = JSON.parse(body.toString('utf8'));
      const events = Array.isArray(payload.events) ? payload.events : [];
      eventCount += events.length;
      for (const event of events) {
        log('TURN.SUMMARY', '32', describeEvent(event) + auth);
        if (PRINT_JSON) console.log(dim(JSON.stringify(event, null, 2)));
      }
      if (events.length === 0) log('TURN.SUMMARY', '32', dim('empty batch (connectivity probe)') + auth);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, received: events.length, total: eventCount }));
    } catch (error) {
      log('TURN.SUMMARY', '31', `bad JSON: ${error.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  if (req.method === 'POST' && url.startsWith('/v1/otlp/')) {
    otlpCount += 1;
    const signal = url.split('/').pop();
    const contentType = req.headers['content-type'] ?? '';
    let detail = `${body.length} bytes (${contentType})`;
    let recordLines = [];
    if (contentType.includes('json')) {
      try {
        const payload = JSON.parse(body.toString('utf8'));
        recordLines = describeOtlpJson(signal, payload);
        if (signal === 'logs') {
          const calls = normalizeOtlpLogs(payload, { receivedAt: new Date().toISOString() });
          llmCallCount += calls.length;
          for (const call of calls) {
            log('LLM.CALL', '36', describeEvent(call) + ` call=${shortId(call.call_id)}` + auth);
            if (PRINT_JSON) console.log(dim(JSON.stringify(call, null, 2)));
          }
        }
        // Raw OTLP payloads are never dumped: the two product events
        // (llm.call, turn.summary) are the only JSON worth reading.
      } catch {
        detail += ' ' + dim('(unparseable JSON)');
      }
    } else {
      const names = sniffOtlpNames(body);
      if (names.length > 0) detail += ' ' + paint('33', names.join(' '));
    }
    // Logs batches are already shown as LLM.CALL lines above; raw OTLP output is noise.
    if (signal !== 'logs') {
      log(`OTLP:${signal}`, '35', detail + auth);
      for (const line of recordLines) console.log(`${dim(timestamp())} ${' '.repeat(9)}${line}`);
    }
    // OTLP/HTTP: the response must use the same encoding as the request.
    if (contentType.includes('json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}'); // empty Export*ServiceResponse
    } else {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end(); // empty message is a valid Export*ServiceResponse
    }
    return;
  }

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, summaries: eventCount, llmCalls: llmCallCount, otlpBatches: otlpCount }));
    return;
  }

  log('HTTP', '33', `${req.method} ${url} -> 404`);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(paint('1', `AgentWatch example backend listening on http://127.0.0.1:${PORT}`));
  console.log(dim('  summary: POST /v1/events'));
  console.log(dim(`  otlp:    POST /v1/otlp/v1/{logs,traces}`));
  console.log(dim(`  connect the bridge:  agentwatch setup --endpoint http://127.0.0.1:${PORT} --yes`));
  console.log();
});
