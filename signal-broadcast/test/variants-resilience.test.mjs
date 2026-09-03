// The incident of 2026-09-03: a single gemini-proxy 500 aborted generation
// entirely, mid-attempt, which skipped the "too long, refuse to send" check
// instead of triggering it. The debunk (374 chars) exceeded X's budget (256),
// and — because generation never reached a clean conclusion — the raw,
// unchecked original went out to a volunteer instead of being refused.
//
// These tests run against a fake proxy, so retry delays are set to ~0 via
// env vars read once at module load, before the require below.
process.env.GEMINI_PROXY_RETRY_ATTEMPTS = '3';
process.env.GEMINI_PROXY_RETRY_DELAY_MS = '1,1';
process.env.GEMINI_PROXY_URL = 'https://fake-proxy.test/generate';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateVariants, callGeminiProxy } = require('../src/variants.js');

function mockFetch({ proxyResponses }) {
  let call = 0;
  return async (url) => {
    if (String(url).includes('metadata.google.internal')) {
      return { ok: true, text: async () => 'fake-identity-token' };
    }
    const step = proxyResponses[Math.min(call, proxyResponses.length - 1)];
    call += 1;
    if (step.error) {
      return { ok: false, status: step.status || 500, text: async () => step.error };
    }
    return { ok: true, json: async () => ({ response: step.response }) };
  };
}

test('callGeminiProxy retries a 500 and succeeds once the service recovers', async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async (url) => {
    if (String(url).includes('metadata.google.internal')) {
      return { ok: true, text: async () => 'tok' };
    }
    attempts += 1;
    if (attempts < 3) return { ok: false, status: 503, text: async () => 'unavailable' };
    return { ok: true, json: async () => ({ response: 'ok' }) };
  };
  try {
    const result = await callGeminiProxy('prompt');
    assert.equal(attempts, 3, 'should have retried twice before the third attempt succeeded');
    assert.deepEqual(result, { response: 'ok' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('callGeminiProxy does not retry a 400 — a malformed request will not fix itself', async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async (url) => {
    if (String(url).includes('metadata.google.internal')) {
      return { ok: true, text: async () => 'tok' };
    }
    attempts += 1;
    return { ok: false, status: 400, text: async () => 'bad request' };
  };
  try {
    await assert.rejects(() => callGeminiProxy('prompt'), /gemini-proxy failed \(400\)/);
    assert.equal(attempts, 1, 'a 4xx must fail fast, not burn the retry budget');
  } finally {
    global.fetch = originalFetch;
  }
});

test('callGeminiProxy gives up after sustained 5xx failures, not after the first', async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async (url) => {
    if (String(url).includes('metadata.google.internal')) {
      return { ok: true, text: async () => 'tok' };
    }
    attempts += 1;
    return { ok: false, status: 500, text: async () => 'down' };
  };
  try {
    await assert.rejects(() => callGeminiProxy('prompt'), /gemini-proxy failed \(500\)/);
    assert.equal(attempts, 3, 'should have used the full retry budget before giving up');
  } finally {
    global.fetch = originalFetch;
  }
});

// This is the actual incident, reproduced: the proxy is down for the entire
// call — every retry of every attempt fails — and the debunk does not fit the
// network's character budget. Before the fix, one throw aborted generateVariants
// mid-loop and the caller's catch left `servable` at 0 with no debunk-variants
// document written; the client then fell back to the raw, unchecked original.
// After the fix, generation must run its full course and correctly refuse.
test('a sustained outage refuses an over-budget debunk instead of leaking the raw text', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch({ proxyResponses: [{ error: 'down', status: 500 }] });
  try {
    const debunk = 'א'.repeat(300); // longer than any plausible X budget
    const result = await generateVariants(debunk, 5, { maxChars: 256, claim: 'טענה' });
    assert.equal(result.tooLong, true, 'must surface as refuse-to-send, not as silent success');
    assert.equal(result.male.length, 0, 'must not fall back to the raw, over-budget text');
  } finally {
    global.fetch = originalFetch;
  }
});

// Same outage, but the debunk already fits — the existing "stands on its own"
// path must still work; a sustained outage should not turn a fine reply into
// a refusal.
test('a sustained outage still serves a debunk that already fits', async () => {
  const originalFetch = global.fetch;
  global.fetch = mockFetch({ proxyResponses: [{ error: 'down', status: 500 }] });
  try {
    const debunk = 'תגובה קצרה שמתאימה למגבלת התווים בלי בעיה.';
    const result = await generateVariants(debunk, 5, { maxChars: 256, claim: 'טענה' });
    assert.equal(result.tooLong, undefined);
    assert.deepEqual(result.male, [debunk]);
  } finally {
    global.fetch = originalFetch;
  }
});

// A transient blip on one attempt must not cost the wordings later attempts
// would have produced — the outer quality-attempt loop has to keep going.
test('one failed attempt does not abort attempts that would have followed it', async () => {
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async (url) => {
    if (String(url).includes('metadata.google.internal')) {
      return { ok: true, text: async () => 'tok' };
    }
    call += 1;
    // Every attempt's retry budget (3 calls) fails, except the run starting
    // at call 4 (the second outer attempt), which succeeds immediately.
    if (call <= 3) return { ok: false, status: 500, text: async () => 'down' };
    return {
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          male: ['הפוסט טוען טענה שגויה על האירוע ומפיץ מידע כוזב באופן פעיל.'],
          female: ['הפוסט טוען טענה שגויה על האירוע ומפיצה מידע כוזב באופן פעיל.'],
        }),
      }),
    };
  };
  try {
    const debunk = 'הפוסט טוען טענה שגויה על האירוע ומפיץ מידע כוזב באופן פעיל.';
    const result = await generateVariants(debunk, 1, { maxChars: 256, claim: 'טענה' });
    assert.ok(result.male.length >= 1, 'the second attempt should have produced a usable wording');
  } finally {
    global.fetch = originalFetch;
  }
});

console.log('variants resilience tests defined');
