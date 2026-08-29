// Our own link shortener — because the debunk source links are political
// content, and a third-party shortener can block, expire, or interpose ads.
//
// A short link looks like https://yoriki-500811.web.app/r/AbC12xy and is
// resolved by a static page on our own Firebase Hosting, which reads the
// mapping from the `short-links` collection and redirects. Clicks are counted
// there (via pwa-events), which finally tells us whether anyone opens the
// debunk sources at all.
//
// The code is a hash of the URL, not a random string: the same source link
// shortened twice — the same statement rebroadcast, say — yields the same
// code instead of a growing pile of duplicates.

const crypto = require('crypto');

const SHORT_LINKS = 'short-links';
const SHORT_BASE = process.env.SHORT_LINK_BASE || 'https://yoriki-500811.web.app/r/';

// 8 base64url chars = 48 bits. Collisions are astronomically unlikely at our
// volume, and a collision is detected (the stored URL is compared) rather
// than silently redirecting somewhere wrong.
const CODE_LENGTH = 8;

function codeFor(url) {
  return crypto.createHash('sha256').update(String(url)).digest('base64url').slice(0, CODE_LENGTH);
}

/**
 * Returns the short URL for `url`, creating the mapping if needed.
 * Falls back to the original URL on any failure — a broken shortener must
 * never cost anyone the actual source link.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} url
 * @param {string} rid  request id, for logs
 * @returns {Promise<string>}
 */
async function shorten(db, url, rid = '') {
  const clean = String(url || '').trim();
  if (!/^https:\/\//i.test(clean)) return clean;   // only shorten real https links

  const code = codeFor(clean);
  try {
    const ref = db.collection(SHORT_LINKS).doc(code);
    const snap = await ref.get();
    if (snap.exists) {
      const stored = snap.data().url;
      if (stored !== clean) {
        // Hash collision — practically impossible, but wrong redirects are the
        // one failure mode this feature must never have.
        console.error(rid, `short-link collision on ${code}; keeping the long URL`);
        return clean;
      }
    } else {
      await ref.set({ url: clean, createdAt: new Date(), clicks: 0 });
    }
    return SHORT_BASE + code;
  } catch (e) {
    console.error(rid, 'short-link creation failed:', e.message);
    return clean;
  }
}

module.exports = { shorten, codeFor, SHORT_LINKS };
