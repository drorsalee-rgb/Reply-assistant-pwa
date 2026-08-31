// Pushes what a volunteer actually did with an alert back to the fake-finding
// server, so it can mark its own row true/false positive.
//
// Ilan asked for a push rather than reading our feedback sheet, which is the
// right shape: the sheet is for a human following up on a complaint, and this
// is a signal for training.
//
// The join key is HIS id. Every alert carries `request_id` (mk_… live, hist_…
// backfill) on the fake-hunting-messages document, and that is what his table
// is keyed by — our messageId means nothing on his side.
//
// PRIVACY: outcomes only. No phone number, no name, no recipient slot, no IP.
// He needs to know that an alert was judged a bad match; he does not need to
// know who judged it.
//
// Dormant until FAKENEWS_OUTCOME_URL is set, so this can ship before he has an
// endpoint and start working the moment he does.

const OUTCOME_URL = process.env.FAKENEWS_OUTCOME_URL || '';
const OUTCOME_SECRET = process.env.FAKENEWS_OUTCOME_SECRET || '';
const TIMEOUT_MS = Number(process.env.FAKENEWS_OUTCOME_TIMEOUT_MS) || 5000;

// What we are willing to say. A closed list rather than passing through
// whatever arrives: this is an outbound channel to a third party, and it
// should carry known values only.
const OUTCOMES = {
  // Borderline verdicts — the strongest signal, because the volunteer was
  // asked the question directly.
  borderline_fits: 'reply_fits',
  borderline_does_not_fit: 'reply_does_not_fit',
  // Reports from ordinary alerts.
  not_fake: 'not_fake',
  reply_mismatch: 'reply_does_not_fit',
  post_wont_open: 'post_unavailable',
  replies_disabled: 'replies_disabled',
  // Actions.
  copy_open: 'reply_published',
  decline: 'declined',
};

function isConfigured() {
  return Boolean(OUTCOME_URL);
}

/**
 * Best effort, and deliberately so: a volunteer's action must never fail
 * because a partner's endpoint is down, and the caller does not wait on the
 * result beyond its own timeout.
 *
 * @param {object} params
 * @param {string} params.requestId  the fake-finding server's own alert id
 * @param {string} params.messageId  ours, for correlation in logs
 * @param {string} params.outcome    a value from OUTCOMES
 * @param {string} [params.note]     free text a volunteer typed, if any
 * @returns {Promise<'sent'|'skipped'|'failed'>}
 */
async function pushOutcome({ requestId, messageId, outcome, note = '' }) {
  if (!isConfigured()) return 'skipped';
  if (!requestId || !OUTCOMES[outcome]) return 'skipped';

  const body = JSON.stringify({
    request_id: requestId,
    message_id: messageId,
    outcome: OUTCOMES[outcome],
    note: note ? String(note).slice(0, 500) : undefined,
    at: new Date().toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OUTCOME_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // X-Yoriki-Secret, as Ilan's endpoint expects. The 1Password entry
        // types the credential "bearer", which I read as an Authorization
        // header — it is not: that field describes how the vault classifies
        // the item, not how his server reads it. He stated the header
        // explicitly, so that is what we send.
        ...(OUTCOME_SECRET ? { 'X-Yoriki-Secret': OUTCOME_SECRET } : {}),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`outcome push rejected (${res.status}) for ${messageId}/${outcome}`);
      return 'failed';
    }
    return 'sent';
  } catch (e) {
    console.warn(`outcome push failed for ${messageId}/${outcome}: ${e.message}`);
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pushOutcome, isConfigured, OUTCOMES };
