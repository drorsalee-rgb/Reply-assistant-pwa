// The archive-replay incident of 2026-08-29: volunteers were asked to reply to
// posts 14-26 days old because nothing on this side looked at the age.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { postAgeDays, checkFreshness, MAX_POST_AGE_DAYS, MAX_BORDERLINE_AGE_DAYS } = require('../src/freshness.js');

// The real alert a volunteer complained about: hist_10eb14557750, sent
// 17:23 UTC on 29/08 for a post from 4 August.
const INCIDENT_URL = 'https://twitter.com/davidcrmsystem/status/2084574287155929141';
const INCIDENT_SENT = Date.parse('2026-08-29T17:23:00Z');

function idFor(ms) {
  return String(BigInt(ms - 1288834974657) << 22n);
}

test('reads the age of the post from the incident', () => {
  assert.equal(Math.round(postAgeDays(INCIDENT_URL, INCIDENT_SENT)), 25);
});

test('that alert would have been refused', () => {
  const { stale, ageDays } = checkFreshness(INCIDENT_URL, { now: INCIDENT_SENT });
  assert.equal(stale, true);
  assert.equal(Math.round(ageDays), 25);
});

test('a post from today passes', () => {
  const now = Date.now();
  const url = 'https://x.com/a/status/' + idFor(now - 3600 * 1000);
  assert.equal(checkFreshness(url, { now: now }).stale, false);
});

test('the boundary is inclusive up to the limit', () => {
  const now = Date.now();
  const justInside = 'https://x.com/a/status/' + idFor(now - (MAX_POST_AGE_DAYS - 0.5) * 86400000);
  const justOutside = 'https://x.com/a/status/' + idFor(now - (MAX_POST_AGE_DAYS + 0.5) * 86400000);
  assert.equal(checkFreshness(justInside, { now: now }).stale, false);
  assert.equal(checkFreshness(justOutside, { now: now }).stale, true);
});

test('x.com and twitter.com are both understood', () => {
  const now = Date.now();
  const id = idFor(now - 30 * 86400000);
  for(const host of ['x.com', 'twitter.com']){
    assert.equal(checkFreshness(`https://${host}/someone/status/${id}`, { now: now }).stale, true, host);
  }
});

test('query parameters do not hide the id', () => {
  const now = Date.now();
  const url = 'https://x.com/a/status/' + idFor(now - 30 * 86400000) + '?s=46&t=Faj6Ayyg';
  assert.equal(checkFreshness(url, { now: now }).stale, true);
});

test('networks without a date in the URL are never refused', () => {
  for(const url of [
    'https://www.instagram.com/p/DcnxGWhChw9/',
    'https://www.facebook.com/share/p/xyz/',
    'https://www.tiktok.com/@user/video/7677555734724365589',
  ]){
    const r = checkFreshness(url);
    assert.equal(r.ageDays, null, url);
    assert.equal(r.stale, false, url);
  }
});

test('a missing or malformed url is not refused', () => {
  for(const url of [null, undefined, '', 'not a url', 'https://x.com/a/status/abc']){
    assert.equal(checkFreshness(url).stale, false, String(url));
  }
});

test('a future-dated id is treated as unknown, not fresh-forever', () => {
  const now = Date.now();
  const future = 'https://x.com/a/status/' + idFor(now + 40 * 86400000);
  assert.equal(postAgeDays(future, now), null);
});

test('a borderline alert gets a longer window, because judging is not replying', () => {
  const now = Date.now();
  const url = 'https://x.com/a/status/' + idFor(now - 20 * 86400000);
  assert.equal(checkFreshness(url, { now }).stale, true, 'too old to reply to');
  assert.equal(checkFreshness(url, { now, borderline: true }).stale, false, 'still worth judging');
});

test("Ilan's first borderline alert, refused at 14 days, now passes", () => {
  const now = Date.now();
  const url = 'https://x.com/a/status/' + idFor(now - 14.3 * 86400000);
  assert.equal(checkFreshness(url, { now }).stale, true);
  assert.equal(checkFreshness(url, { now, borderline: true }).stale, false);
});

test('borderline is not unlimited', () => {
  const now = Date.now();
  const url = 'https://x.com/a/status/' + idFor(now - (MAX_BORDERLINE_AGE_DAYS + 5) * 86400000);
  assert.equal(checkFreshness(url, { now, borderline: true }).stale, true);
});

test('the reported limit matches the path taken', () => {
  const now = Date.now();
  const url = 'https://x.com/a/status/' + idFor(now - 1 * 86400000);
  assert.equal(checkFreshness(url, { now }).limit, MAX_POST_AGE_DAYS);
  assert.equal(checkFreshness(url, { now, borderline: true }).limit, MAX_BORDERLINE_AGE_DAYS);
});
