// Per-IP ceilings for the two public endpoints.
//
// Nothing here consumes a finite resource the way claiming a reaction does,
// so this is about integrity rather than availability:
//   /feedback  — floods the Google Sheet the fake-hunting team reads
//   /e         — inflates the usage numbers the dashboard reports
//
// Generous on purpose: Israeli carriers put thousands of subscribers behind
// one CGNAT address, so a tight limit would drop real volunteers' events long
// before it inconvenienced anyone abusing it.

const WINDOW_MS = 60 * 1000;

const LIMITS = {
  // A person files one report and moves on. Ten a minute is already absurd.
  feedback: Number(process.env.RATE_LIMIT_FEEDBACK) || 10,
  // Events fire on open, style choice, copy and decline, and a volunteer may
  // legitimately reopen a few links in a row.
  events: Number(process.env.RATE_LIMIT_EVENTS) || 120,
  // Short-link click beacons: one per redirect, and nobody redirects sixty
  // times a minute by hand.
  rc: Number(process.env.RATE_LIMIT_RC) || 60,
};

const hits = new Map();

function prune(now){
  for(const [key, times] of hits){
    const live = times.filter(t => now - t < WINDOW_MS);
    if(live.length) hits.set(key, live);
    else hits.delete(key);
  }
}

// Cloud Run puts the real caller first in X-Forwarded-For; the rest are hops.
function clientIp(req){
  const forwarded = req.get && req.get('X-Forwarded-For');
  if(forwarded) return forwarded.split(',')[0].trim();
  return req.ip || 'unknown';
}

/**
 * @param {string} bucket  which endpoint
 * @param {string} ip
 * @param {object} [deps]  test seam
 * @returns {boolean} true when the caller is over the ceiling
 */
function overLimit(bucket, ip, deps = {}){
  const now = deps.now ?? Date.now();
  if(hits.size > 5000) prune(now);
  const key = `${bucket}:${ip}`;
  const times = (hits.get(key) || []).filter(t => now - t < WINDOW_MS);
  times.push(now);
  hits.set(key, times);
  return times.length > (LIMITS[bucket] || 60);
}

function resetRateLimit(){ hits.clear(); }

module.exports = { clientIp, overLimit, resetRateLimit, LIMITS, WINDOW_MS };
