// The outbound channel to the fake-finding server. It carries what a volunteer
// concluded so that side can mark its row true/false positive — and it must
// never carry who they were, nor fail a volunteer's action when it breaks.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

function withServer(handler) {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
        handler(req, res);
      });
    });
    server.listen(0, () => resolve({ server, received, port: server.address().port }));
  });
}

async function loadWith(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve('../src/outcomes.js')];
  return require('../src/outcomes.js');
}

test('does nothing until an endpoint is configured', async () => {
  const m = await loadWith({ FAKENEWS_OUTCOME_URL: null });
  assert.equal(m.isConfigured(), false);
  assert.equal(await m.pushOutcome({
    requestId: 'mk_1', messageId: 'a', outcome: 'borderline_fits',
  }), 'skipped');
});

test('sends the partner id, the mapped outcome, and a Bearer credential', async () => {
  const { server, received, port } = await withServer((req, res) => { res.writeHead(200); res.end('{}'); });
  const m = await loadWith({
    FAKENEWS_OUTCOME_URL: `http://127.0.0.1:${port}/outcome`,
    FAKENEWS_OUTCOME_SECRET: 's3cret',
  });
  const r = await m.pushOutcome({
    requestId: 'mk_43e85f264dacb6fd', messageId: 'bl-1', outcome: 'borderline_does_not_fit',
  });
  server.close();
  assert.equal(r, 'sent');
  assert.equal(received[0].body.request_id, 'mk_43e85f264dacb6fd');
  assert.equal(received[0].body.outcome, 'reply_does_not_fit');
  assert.equal(received[0].headers.authorization, 'Bearer s3cret');
});

test('never carries who the volunteer was', async () => {
  const { server, received, port } = await withServer((req, res) => { res.writeHead(200); res.end('{}'); });
  const m = await loadWith({ FAKENEWS_OUTCOME_URL: `http://127.0.0.1:${port}/o`, FAKENEWS_OUTCOME_SECRET: null });
  await m.pushOutcome({ requestId: 'mk_1', messageId: 'm', outcome: 'copy_open' });
  server.close();
  const sent = JSON.stringify(received[0].body);
  for (const forbidden of ['phone', 'firstName', 'slot', 'recipient', '972', 'ip']) {
    assert.ok(!sent.includes(forbidden), `payload must not contain ${forbidden}: ${sent}`);
  }
  assert.deepEqual(Object.keys(received[0].body).sort(), ['at', 'message_id', 'outcome', 'request_id']);
});

test('only known outcomes go out', async () => {
  const { server, received, port } = await withServer((req, res) => { res.writeHead(200); res.end('{}'); });
  const m = await loadWith({ FAKENEWS_OUTCOME_URL: `http://127.0.0.1:${port}/o` });
  assert.equal(await m.pushOutcome({ requestId: 'r', messageId: 'm', outcome: 'made_up' }), 'skipped');
  assert.equal(received.length, 0);
  server.close();
});

test('an alert with no partner id is not pushed', async () => {
  const { server, received, port } = await withServer((req, res) => { res.writeHead(200); res.end('{}'); });
  const m = await loadWith({ FAKENEWS_OUTCOME_URL: `http://127.0.0.1:${port}/o` });
  assert.equal(await m.pushOutcome({ requestId: '', messageId: 'm', outcome: 'copy_open' }), 'skipped');
  assert.equal(received.length, 0);
  server.close();
});

test('a rejecting endpoint fails quietly rather than throwing', async () => {
  const { server, port } = await withServer((req, res) => { res.writeHead(500); res.end('nope'); });
  const m = await loadWith({ FAKENEWS_OUTCOME_URL: `http://127.0.0.1:${port}/o` });
  assert.equal(await m.pushOutcome({ requestId: 'r', messageId: 'm', outcome: 'decline' }), 'failed');
  server.close();
});

test('a hanging endpoint gives up instead of holding the request open', async () => {
  const { server, port } = await withServer(() => { /* never responds */ });
  const m = await loadWith({
    FAKENEWS_OUTCOME_URL: `http://127.0.0.1:${port}/o`,
    FAKENEWS_OUTCOME_TIMEOUT_MS: '300',
  });
  const started = Date.now();
  assert.equal(await m.pushOutcome({ requestId: 'r', messageId: 'm', outcome: 'decline' }), 'failed');
  assert.ok(Date.now() - started < 2000, 'should abort well before any user notices');
  server.close();
});

test('a free-text note is passed but capped', async () => {
  const { server, received, port } = await withServer((req, res) => { res.writeHead(200); res.end('{}'); });
  const m = await loadWith({ FAKENEWS_OUTCOME_URL: `http://127.0.0.1:${port}/o` });
  await m.pushOutcome({ requestId: 'r', messageId: 'm', outcome: 'not_fake', note: 'x'.repeat(900) });
  server.close();
  assert.equal(received[0].body.note.length, 500);
});
