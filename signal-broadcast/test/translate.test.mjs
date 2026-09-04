// Translation of a post's own text, before a volunteer is asked to judge or
// rebut it in Hebrew.
//
// Three reports over two days, and the first two diagnoses were both wrong:
//
//   1. (2026-09-03) An Arabic post shown verbatim — blamed on the check
//      gating translation only looking for Latin letters.
//   2. (2026-09-03) An English summary shown verbatim — blamed on Google's
//      auto-detector seeing embedded Hebrew quotes and reporting the source
//      language as Hebrew, making the call a no-op.
//   3. (2026-09-04) Another English summary. This time the production logs
//      were checked: 90+ consecutive failures since 2026-08-23, zero
//      successes. Translation had never worked in production. The
//      translate.googleapis.com endpoint works from a laptop and not from
//      Cloud Run; both earlier fixes changed logic that never ran.
//
// Now routed through gemini-proxy, which this service already uses
// successfully from Cloud Run many times a day.

// The proxy retries with backoff on failure; set before the require below so
// the outage cases don't spend the real ~4s each.
process.env.GEMINI_PROXY_RETRY_DELAY_MS = '1,1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { needsTranslation, translateToHebrew, buildTranslationPrompt } = require('../src/translate.js');

// translateToHebrew -> callGeminiProxy -> identityToken (metadata server),
// then a POST to the proxy. Both hops go through fetch.
function mockProxy(respond) {
  return async (url) => {
    if (String(url).includes('metadata.google.internal')) {
      return { ok: true, text: async () => 'fake-identity-token' };
    }
    return respond();
  };
}

test('needsTranslation: only Hebrew is exempt, any other script counts', () => {
  assert.equal(needsTranslation('הפוסט טוען משהו בעברית תקנית לגמרי.'), false);
  assert.equal(needsTranslation('العربية النص هنا وليس فيه عبرية على الإطلاق'), true);
  assert.equal(needsTranslation('This entire sentence is in English.'), true);
  assert.equal(
    needsTranslation('הפוסט מצטט את Reuters על האירוע.'),
    false,
    'a Hebrew sentence with an embedded Latin brand is still Hebrew'
  );
});

test('the prompt tells the model to leave existing Hebrew alone', () => {
  // Incident 2 was a mixed-language text. Whatever else changes, the
  // instruction that keeps already-Hebrew quotes intact has to survive.
  const prompt = buildTranslationPrompt('some text');
  assert.match(prompt, /כבר כתובים בעברית/);
  assert.match(prompt, /some text/);
});

test('incident 1: an Arabic post is translated (regression)', async () => {
  const original = global.fetch;
  global.fetch = mockProxy(() => ({
    ok: true,
    json: async () => ({ response: 'משטרת ישראל עצרה פלסטינית שפתחה חשבונות מזויפים.' }),
  }));
  try {
    const out = await translateToHebrew('نص عربي بالكامل يحتاج إلى ترجمة كاملة إلى العبرية هنا');
    assert.equal(out, 'משטרת ישראל עצרה פלסטינית שפתחה חשבונות מזויפים.');
  } finally {
    global.fetch = original;
  }
});

test('incident 2: a model that echoes its input is caught, not trusted', async () => {
  const original = global.fetch;
  const english = 'Main topic: a debate. Quote: "יושב כאן אדם" said the panelist about extremism today.';
  global.fetch = mockProxy(() => ({
    ok: true,
    json: async () => ({ response: english }),   // no-op, as the old endpoint did
  }));
  try {
    const out = await translateToHebrew(english);
    assert.equal(out, null, 'output that still needs translation must count as a failure');
  } finally {
    global.fetch = original;
  }
});

// Incident 3 is the important one: the transport itself failing. Before the
// fix this was invisible — every failure was silently swallowed and the
// English original was sent instead.
test('incident 3: a proxy outage returns null so the caller falls back', async () => {
  const original = global.fetch;
  global.fetch = mockProxy(() => ({ ok: false, status: 500, text: async () => 'down' }));
  try {
    const out = await translateToHebrew('English text that needs translating into Hebrew');
    assert.equal(out, null);
  } finally {
    global.fetch = original;
  }
});

test('an empty model response returns null rather than an empty snippet', async () => {
  const original = global.fetch;
  global.fetch = mockProxy(() => ({ ok: true, json: async () => ({ response: '   ' }) }));
  try {
    const out = await translateToHebrew('English text that needs translating into Hebrew');
    assert.equal(out, null);
  } finally {
    global.fetch = original;
  }
});

test('a network-level throw returns null rather than propagating', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const out = await translateToHebrew('English text that needs translating into Hebrew');
    assert.equal(out, null);
  } finally {
    global.fetch = original;
  }
});
