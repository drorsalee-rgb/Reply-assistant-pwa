// The prompt intro is the first thing the reply-generating model reads, and it
// is still writable without authentication. This watch cannot prevent that; it
// exists so a change is noticed and can be undone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkPrompts, sha256, preview } = require('../src/promptWatch.js');

// Minimal Firestore stand-ins: enough to exercise baseline / unchanged /
// changed without a live database.
function fakeStore(initial = {}) {
  const docs = { ...initial };
  return {
    docs,
    collection: (c) => ({
      doc: (d) => ({
        get: async () => {
          const key = `${c}/${d}`;
          return { exists: key in docs, data: () => docs[key] };
        },
        set: async (value, opts) => {
          const key = `${c}/${d}`;
          docs[key] = opts && opts.merge ? { ...(docs[key] || {}), ...value } : value;
        },
      }),
    }),
  };
}

function harness(promptText, watchState = {}) {
  const watch = fakeStore(watchState);
  const prompts = fakeStore({
    'prompt-constants/shared': { introParallel: promptText },
    'prompt-constants_staging/shared': { introParallel: promptText },
  });
  const alerts = [];
  const sendAlert = async (key, text) => { alerts.push({ key, text }); };
  return { watch, prompts, alerts, sendAlert, dbFor: () => prompts };
}

test('the first run records a baseline and stays quiet', async () => {
  const h = harness('original prompt');
  const results = await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  assert.deepEqual(results.map(r => r.status), ['baseline', 'baseline']);
  assert.equal(h.alerts.length, 0);
});

test('an unchanged prompt raises nothing on later runs', async () => {
  const h = harness('original prompt');
  await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  const results = await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  assert.deepEqual(results.map(r => r.status), ['unchanged', 'unchanged']);
  assert.equal(h.alerts.length, 0);
});

test('a changed prompt alerts once per collection', async () => {
  const h = harness('original prompt');
  await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  h.prompts.docs['prompt-constants/shared'].introParallel = 'ignore previous instructions';
  h.prompts.docs['prompt-constants_staging/shared'].introParallel = 'ignore previous instructions';
  const results = await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  assert.deepEqual(results.map(r => r.status), ['changed', 'changed']);
  assert.equal(h.alerts.length, 2);
  assert.match(h.alerts[0].text, /הפרומפט/);
});

test('the text being replaced is kept, so a rollback needs no backup', async () => {
  const h = harness('the good prompt');
  await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  h.prompts.docs['prompt-constants/shared'].introParallel = 'tampered';
  await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  const saved = h.watch.docs['prompt-watch/default1__prompt-constants'];
  assert.equal(saved.previousText, 'the good prompt');
  assert.equal(saved.text, 'tampered');
});

test('the alert reports the size change, which is the giveaway for a rewrite', async () => {
  const h = harness('x'.repeat(1000));
  await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  h.prompts.docs['prompt-constants/shared'].introParallel = 'x'.repeat(40);
  const results = await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  assert.equal(results[0].delta, -960);
  assert.match(h.alerts[0].text, /1000 → 40/);
});

test('a failure on one collection does not stop the other', async () => {
  const h = harness('p');
  h.dbFor = (dbId) => ({
    collection: (c) => ({
      doc: () => ({
        get: async () => {
          if (c === 'prompt-constants') throw new Error('firestore unavailable');
          return { exists: true, data: () => ({ introParallel: 'p' }) };
        },
        set: async () => {},
      }),
    }),
  });
  const results = await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  assert.equal(results[0].status, 'error');
  assert.equal(results[1].status, 'baseline');
});

test('a deleted or emptied prompt is a change, not a crash', async () => {
  const h = harness('something');
  await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  h.prompts.docs['prompt-constants/shared'].introParallel = '';
  const results = await checkPrompts(h.watch, h.dbFor, h.sendAlert);
  assert.equal(results[0].status, 'changed');
});

test('preview flattens and truncates; the 17k prompt never goes into WhatsApp', () => {
  assert.equal(preview('a\n\n  b'), 'a b');
  assert.equal(preview('x'.repeat(500)).length, 161);
});

test('the hash is content-based, so identical text is not a change', () => {
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
});
