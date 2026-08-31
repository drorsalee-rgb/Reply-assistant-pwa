// How old is the post we are about to ask volunteers to reply to?
//
// On 2026-08-29 the fake-finding server lost its record of what it had already
// delivered and began re-sending its archive: 32 of 39 alerts pointed at posts
// 14-26 days old, and volunteers were asked to reply to three-week-old tweets.
// We accepted every one of them, because nothing here ever looked at the age.
//
// Two independent reasons to check it:
//   - a reply to a stale post is wasted volunteer effort; the conversation has
//     moved on and the reply lands where nobody is reading;
//   - an old post arriving at all is a symptom. A partner re-sending history
//     looks exactly like this, and the alert is the cheapest place to notice.

// X/Twitter snowflake ids encode their creation time, so a post's age is known
// from the URL alone — no network call, and it stays right even when the
// alert's own timestamps are wrong.
const TWITTER_EPOCH_MS = 1288834974657;

/**
 * @param {string} postUrl
 * @param {number} [now]
 * @returns {number|null} age in days, or null when the URL carries no date
 */
function postAgeDays(postUrl, now = Date.now()) {
  const m = String(postUrl || '').match(/(?:twitter\.com|x\.com)\/[A-Za-z0-9_]+\/status\/(\d+)/i);
  if (!m) return null;
  let id;
  try { id = BigInt(m[1]); } catch (e) { return null; }
  const ms = Number(id >> 22n) + TWITTER_EPOCH_MS;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const age = (now - ms) / 86400000;
  // A post dated in the future is a malformed id, not a fresh post.
  return age < -1 ? null : age;
}

// Deliberately generous. A debunk is still worth posting days later; the
// target is the archive-replay case, which runs to weeks.
const MAX_POST_AGE_DAYS = Number(process.env.MAX_POST_AGE_DAYS) || 14;

// Borderline alerts get longer. The limit above exists because REPLYING to a
// stale post is wasted effort — but a borderline alert asks the reader to
// judge whether the suggested reply fits, and a judgement is just as useful on
// an older post. Blocking those would silence the training signal the whole
// feature exists to collect. Ilan's first borderline test was refused at
// exactly 14 days, which is what surfaced this.
const MAX_BORDERLINE_AGE_DAYS = Number(process.env.MAX_BORDERLINE_AGE_DAYS) || 45;

/**
 * Whether an alert should be refused for being about an old post.
 *
 * Only X posts carry a readable date. Facebook, Instagram and TikTok URLs
 * return null and are always allowed — dropping them silently would be worse
 * than the problem this guards against.
 *
 * @returns {{stale: boolean, ageDays: number|null}}
 */
function checkFreshness(postUrl, { now = Date.now(), borderline = false } = {}) {
  const ageDays = postAgeDays(postUrl, now);
  const limit = borderline ? MAX_BORDERLINE_AGE_DAYS : MAX_POST_AGE_DAYS;
  return { stale: ageDays !== null && ageDays > limit, ageDays, limit };
}

module.exports = { postAgeDays, checkFreshness, MAX_POST_AGE_DAYS, MAX_BORDERLINE_AGE_DAYS };
