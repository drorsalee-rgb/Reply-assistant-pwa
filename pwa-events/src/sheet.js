// Appends debunk problem reports to a Google Sheet, so the fake-hunting team
// can review them without being given access to Firestore.
//
// The sheet is owned by a person, not by this service: create it in Drive and
// share it with the runtime service account as an Editor, then set SHEET_ID.
// Until that is done, reports are still recorded in Firestore — the sheet is a
// convenience, never the system of record.

const HEADERS = [
  'when (Israel)',
  'message_id',
  'reasons',
  'note',
  'reported by',
  'claim',
  'wording shown',
  'post_url',
  'source (message_link)',
  'network',
  'slot',
];

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Cloud Run's metadata server mints tokens for the runtime service account;
// no key file is involved.
let cachedToken = { value: null, expiresAt: 0 };

async function accessToken(){
  if(cachedToken.value && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const url = 'http://metadata.google.internal/computeMetadata/v1/instance/'
    + 'service-accounts/default/token?scopes=' + encodeURIComponent(SCOPE);
  const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
  if(!res.ok) throw new Error(`metadata token failed (${res.status})`);
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in || 60) - 30, 10) * 1000,
  };
  return cachedToken.value;
}

async function api(sheetId, path, options = {}){
  const token = await accessToken();
  const res = await fetch(`${SHEETS_API}/${sheetId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if(!res.ok){
    const text = await res.text();
    throw new Error(`sheets ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Written once, so whoever opens the sheet knows what the columns mean.
async function ensureHeaders(sheetId){
  const first = await api(sheetId, '/values/A1:A1');
  if(first.values && first.values.length) return;
  await api(sheetId, '/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({ values: [HEADERS] }),
  });
}

/**
 * @param {string} sheetId
 * @param {object} row
 */
async function appendReport(sheetId, row){
  await ensureHeaders(sheetId);
  await api(sheetId, '/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({
      values: [[
        row.when,
        row.messageId,
        row.reasons,
        row.note,
        row.reportedBy,
        row.claim,
        row.wording,
        row.postUrl,
        row.sourceUrl,
        row.network,
        row.slot,
      ]],
    }),
  });
}

module.exports = { appendReport, HEADERS };
