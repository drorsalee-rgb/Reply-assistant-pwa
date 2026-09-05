// Is the post still there?
//
// Volunteers reported "the post won't open" 7 times out of 77 reports. Of the
// six we could still check, five returned 404: the post had been deleted
// between the fake-finding server seeing it and a volunteer opening the alert.
// Each of those cost someone the whole exercise — open the link, find nothing,
// come back, file a report.
//
// One HTTP request answers it. Verified from Cloud Run, not just from a
// laptop, because that distinction is exactly what made two "fixes" to the
// translation code useless on 2026-09-03: deleted posts return 404 and live
// ones return 200 from the service's own datacenter IP, with no login wall,
// no CAPTCHA, in 316-930ms.
//
// FAILS OPEN, deliberately and in every direction. Only an explicit 404 stops
// an alert. A timeout, a 429, a network error, an unparseable URL — anything
// else at all — means send. A liveness check that silences real alerts when
// X rate-limits us would cost far more than the deleted posts it catches.

const TIMEOUT_MS = Number(process.env.LIVENESS_TIMEOUT_MS) || 8000;

// Only networks whose deleted posts we have actually observed returning 404.
// Facebook and Instagram answer 200 for almost everything, including content
// that is gone, so checking them would add latency and tell us nothing.
const CHECKABLE = /^(?:www\.)?(?:twitter|x)\.com$/i;

function isCheckable(url){
  try{
    return CHECKABLE.test(new URL(String(url || '')).hostname);
  }catch(e){
    return false;
  }
}

/**
 * @returns {Promise<{deleted: boolean, status: number|null, reason: string}>}
 *   `deleted` is true ONLY on a definite 404. Everything else — including
 *   every kind of failure — reports false, so the caller sends.
 */
async function checkPostAlive(url, rid = ''){
  if(!isCheckable(url)) return { deleted: false, status: null, reason: 'not_checkable' };

  try{
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      // Not a browser string: the same agent the share-link resolver uses,
      // which X answers plainly rather than with an interstitial.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YorikiLinkResolver/1.0)' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if(res.status === 404){
      console.log(rid, `post is gone (404): ${url}`);
      return { deleted: true, status: 404, reason: 'not_found' };
    }
    return { deleted: false, status: res.status, reason: 'alive' };
  }catch(e){
    // Rate limiting, DNS, a socket reset, a timeout. Never a reason to
    // withhold an alert.
    console.log(rid, `liveness check failed for ${url} (${e.message}); sending anyway`);
    return { deleted: false, status: null, reason: 'check_failed' };
  }
}

module.exports = { checkPostAlive, isCheckable };
