#!/usr/bin/env node
/**
 * Example AgentWatch backend: a zero-dependency Node.js server that accepts
 * everything the Bridge and the agents' native OpenTelemetry send, and logs
 * it to the console. For local testing only.
 *
 *   npm run example              # listens on http://127.0.0.1:8787
 *   PORT=9000 npm run example
 *
 * Endpoints:
 *   POST /v1/events               canonical AgentWatch events (JSON)
 *   POST /v1/otlp/v1/metrics      native agent OTLP (protobuf or JSON)
 *   POST /v1/otlp/v1/logs
 *   POST /v1/otlp/v1/traces
 *   GET  /                        health check
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const isTTY = process.stdout.isTTY;
const paint = (code, text) => (isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (text) => paint('90', text);
const timestamp = () => new Date().toISOString().slice(11, 23);

let eventCount = 0;
let otlpCount = 0;

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
  if (event.ai?.model) parts.push(`model=${event.ai.model}`);
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
      for (const event of events) log('EVENT', '32', describeEvent(event) + auth);
      if (events.length === 0) log('EVENT', '32', dim('empty batch (connectivity probe)') + auth);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, received: events.length, total: eventCount }));
    } catch (error) {
      log('EVENT', '31', `bad JSON: ${error.message}`);
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
    if (contentType.includes('json')) {
      detail += ' ' + dim(body.toString('utf8').slice(0, 200));
    } else {
      const names = sniffOtlpNames(body);
      if (names.length > 0) detail += ' ' + paint('33', names.join(' '));
    }
    log(`OTLP:${signal}`, '35', detail + auth);
    // 200 + empty body is a valid (empty) Export*ServiceResponse.
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end();
    return;
  }

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, events: eventCount, otlpBatches: otlpCount }));
    return;
  }

  log('HTTP', '33', `${req.method} ${url} -> 404`);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(paint('1', `AgentWatch example backend listening on http://127.0.0.1:${PORT}`));
  console.log(dim('  events:  POST /v1/events'));
  console.log(dim(`  otlp:    POST /v1/otlp/v1/{metrics,logs,traces}`));
  console.log(dim(`  connect the bridge:  agentwatch setup --endpoint http://127.0.0.1:${PORT} --yes`));
  console.log();
});
