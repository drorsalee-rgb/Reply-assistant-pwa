// Two real incidents, same day, same code:
//
//   1. A borderline alert quoted an Arabic post verbatim to a Hebrew-reading
//      volunteer — the check gating translation only looked for Latin
//      letters, so Arabic was invisible to it.
//   2. After fixing (1) with sl=auto, an English video summary that quoted a
//      couple of sentences of Hebrew dialogue went out completely
//      untranslated — Google's auto-detector saw the embedded Hebrew and
//      called the whole blob's SOURCE language Hebrew, so sl=auto became
//      sl=he and the translation was a silent no-op.
//
// These tests run against a mocked fetch so they don't depend on Google's
// translate endpoint being reachable or behaving consistently over time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { needsTranslation, dominantForeignScript, translateToHebrew } = require('../src/translate.js');

function mockTranslateFetch(handler) {
  return async (url) => {
    const q = decodeURIComponent(String(url).match(/[?&]q=([^&]+)/)[1]);
    const sl = String(url).match(/[?&]sl=([^&]+)/)[1];
    const { translated, detectedSource } = handler(q, sl);
    return {
      ok: true,
      json: async () => [[[translated, q, null, null, 5]], null, detectedSource],
    };
  };
}

test('needsTranslation: only Hebrew is exempt, any other script counts', () => {
  assert.equal(needsTranslation('הפוסט טוען משהו בעברית תקנית לגמרי.'), false);
  assert.equal(needsTranslation('العربية النص هنا وليس فيه عبرية على الإطلاق'), true);
  assert.equal(needsTranslation('This entire sentence is in English.'), true);
  assert.equal(needsTranslation('הפוסט מצטט את Reuters על האירוע.'), false, 'a Hebrew sentence with an embedded Latin brand is still Hebrew');
});

test('dominantForeignScript picks the script that actually dominates', () => {
  assert.equal(dominantForeignScript('This is English text with no other script.'), 'en');
  assert.equal(dominantForeignScript('هذا نص عربي بالكامل'), 'ar');
  assert.equal(dominantForeignScript('Это русский текст'), 'ru');
  assert.equal(dominantForeignScript('123 456 !!!'), 'auto', 'no letters at all falls back to auto');
});

test('incident 1: an Arabic post is detected and translated (regression)', async () => {
  const original = global.fetch;
  global.fetch = mockTranslateFetch((q, sl) => {
    assert.equal(sl, 'ar', 'must ask for Arabic explicitly, not auto-detect');
    return { translated: 'תרגום עברי תקין של הפוסט הערבי.' };
  });
  try {
    const out = await translateToHebrew('نص عربي بالكامل يحتاج إلى ترجمة كاملة إلى العبرية هنا');
    assert.equal(out, 'תרגום עברי תקין של הפוסט הערבי.');
  } finally {
    global.fetch = original;
  }
});

test('incident 2: sl=auto misdetecting mixed English+Hebrew as Hebrew is caught, not trusted', async () => {
  const original = global.fetch;
  // Simulates exactly what Google's endpoint did: asked with an explicit
  // source language, it still might echo the input back unchanged (a
  // misbehaving or overridden endpoint) — the point of this test is that our
  // OWN output verification catches a no-op regardless of why it happened.
  const englishWithHebrewQuote = 'Main topic: a debate. Quote: "יושב כאן אדם" said the panelist about extremism in the discussion today.';
  global.fetch = mockTranslateFetch((q, sl) => {
    assert.equal(sl, 'en', 'the text is mostly Latin script, so it must be asked for as English, not auto');
    return { translated: q };   // no-op: proxy for the real misdetection bug
  });
  try {
    const out = await translateToHebrew(englishWithHebrewQuote);
    assert.equal(out, null, 'a no-op "translation" must be treated as a failure, not a success');
  } finally {
    global.fetch = original;
  }
});

test('a genuine failed HTTP response returns null', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    const out = await translateToHebrew('some text needing translation in English');
    assert.equal(out, null);
  } finally {
    global.fetch = original;
  }
});

test('a network-level throw returns null rather than propagating', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const out = await translateToHebrew('some text needing translation in English');
    assert.equal(out, null);
  } finally {
    global.fetch = original;
  }
});
