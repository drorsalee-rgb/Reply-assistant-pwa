// A post deleted between the fake-finding server seeing it and the alert going
// out. Volunteers reported this seven times; five of the six still checkable
// returned 404.
//
// The property that matters most here is not that it catches deletions — it is
// that it NEVER withholds an alert for any other reason. A liveness check that
// goes quiet when X rate-limits us would cost far more than the deleted posts
// it catches, so every failure path is tested explicitly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkPostAlive, isCheckable } = require('../src/liveness.js');

const DELETED = 'https://twitter.com/yossibaum/status/2093142862367989771';
const LIVE = 'https://x.com/Kulanu_710/status/2095107921587638535';

function mockStatus(status) {
  return async () => ({ status, url: 'https://x.com/whatever' });
}

test('only networks whose deletions we have observed are checked', () => {
  assert.equal(isCheckable(DELETED), true);
  assert.equal(isCheckable(LIVE), true);
  assert.equal(isCheckable('https://www.facebook.com/reel/123/'), false,
    'Facebook answers 200 for content that is gone — checking it tells us nothing');
  assert.equal(isCheckable('https://www.instagram.com/p/abc/'), false);
  assert.equal(isCheckable('not a url'), false);
  assert.equal(isCheckable(''), false);
});

test('a definite 404 is the one case that stops an alert', async () => {
  const original = global.fetch;
  global.fetch = mockStatus(404);
  try {
    const r = await checkPostAlive(DELETED);
    assert.equal(r.deleted, true);
    assert.equal(r.reason, 'not_found');
  } finally {
    global.fetch = original;
  }
});

test('a live post is not blocked', async () => {
  const original = global.fetch;
  global.fetch = mockStatus(200);
  try {
    const r = await checkPostAlive(LIVE);
    assert.equal(r.deleted, false);
    assert.equal(r.reason, 'alive');
  } finally {
    global.fetch = original;
  }
});

// Everything below is the fail-open contract. Each of these must send.
test('rate limiting does not withhold an alert', async () => {
  const original = global.fetch;
  global.fetch = mockStatus(429);
  try {
    assert.equal((await checkPostAlive(LIVE)).deleted, false);
  } finally {
    global.fetch = original;
  }
});

test('a server error does not withhold an alert', async () => {
  const original = global.fetch;
  global.fetch = mockStatus(503);
  try {
    assert.equal((await checkPostAlive(LIVE)).deleted, false);
  } finally {
    global.fetch = original;
  }
});

test('a timeout or network failure does not withhold an alert', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
  try {
    const r = await checkPostAlive(LIVE);
    assert.equal(r.deleted, false);
    assert.equal(r.reason, 'check_failed');
  } finally {
    global.fetch = original;
  }
});

test('an unparseable URL is not checked and not blocked', async () => {
  const original = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { status: 404 }; };
  try {
    const r = await checkPostAlive('::::not a url::::');
    assert.equal(r.deleted, false);
    assert.equal(r.reason, 'not_checkable');
    assert.equal(called, false, 'must not even attempt a request');
  } finally {
    global.fetch = original;
  }
});

test('a 403 — a protected account, not a deletion — still sends', async () => {
  const original = global.fetch;
  global.fetch = mockStatus(403);
  try {
    assert.equal((await checkPostAlive(LIVE)).deleted, false);
  } finally {
    global.fetch = original;
  }
});
