// Operator-to-operator WhatsApp messages: telling Ilan about a payload change,
// sending Dror a sample alert, apologising to someone the bot mishandled.
//
// This used to be done by adding an endpoint, deploying, sending, removing it
// and deploying again — three times in one day, each cycle leaving a window in
// which a deployed endpoint would send arbitrary text to any number at all.
//
// The dangerous part was never "send a message", it was "to anyone". So the
// endpoint is permanent and the recipients are fixed: a number that is not on
// the allowlist is refused, and adding one is a config change someone has to
// make deliberately.
//
// This is NOT a broadcast path. Volunteers are messaged through
// /api/broadcast and /api/broadcast-fake-hunting, which draw from the opt-in
// pool and log every send.

// Kept in code rather than only in config so the default is reviewable here.
// NOTIFY_ALLOWLIST overrides it entirely when set.
const DEFAULT_ALLOWLIST = [
  '+972547554469',   // Dror
  '+972542451181'    // Ilan
];

// One call is a message to a person, occasionally to both of them. Anything
// larger is a broadcast wearing a disguise.
const MAX_RECIPIENTS = 5;
const MAX_MESSAGE_CHARS = 4096;   // Beacon's own cap

// "054-755-4469", "0547554469" and "+972 54 755 4469" are one number. Compare
// on digits alone, with the Israeli national 0 rewritten to the country code
// so the two spellings meet.
function normalisePhone(input){
  let digits = String(input || '').replace(/\D/g, '');
  if(!digits) return '';
  if(digits.startsWith('00')) digits = digits.slice(2);
  if(digits.startsWith('0')) digits = '972' + digits.slice(1);
  return '+' + digits;
}

function allowlist(){
  const configured = (process.env.NOTIFY_ALLOWLIST || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const source = configured.length ? configured : DEFAULT_ALLOWLIST;
  return new Set(source.map(normalisePhone).filter(Boolean));
}

// Logs and error messages must not carry someone's full number around; the
// last four digits are enough to tell which recipient a line refers to.
function phoneLabel(phone){
  const normalised = normalisePhone(phone);
  return normalised ? '…' + normalised.slice(-4) : '(invalid)';
}

/**
 * Validates a notify request.
 *
 * @returns {{ok: true, phones: string[], message: string}
 *          | {ok: false, status: number, error: string}}
 */
function validate(body){
  const { phones, message } = body || {};

  if(!Array.isArray(phones) || !phones.length){
    return { ok: false, status: 400, error: 'phones[] is required' };
  }
  if(phones.length > MAX_RECIPIENTS){
    return { ok: false, status: 400,
      error: `at most ${MAX_RECIPIENTS} recipients; this endpoint is not a broadcast channel` };
  }
  if(typeof message !== 'string' || !message.trim()){
    return { ok: false, status: 400, error: 'message is required' };
  }
  if(message.length > MAX_MESSAGE_CHARS){
    return { ok: false, status: 400,
      error: `message is ${message.length} characters; the limit is ${MAX_MESSAGE_CHARS}` };
  }

  const allowed = allowlist();
  const normalised = phones.map(normalisePhone);

  const invalid = phones.filter((p, i) => !normalised[i]);
  if(invalid.length){
    return { ok: false, status: 400, error: 'one or more phone numbers are unreadable' };
  }

  const refused = normalised.filter(p => !allowed.has(p));
  if(refused.length){
    return { ok: false, status: 403,
      error: `not on the notify allowlist: ${refused.map(phoneLabel).join(', ')}`
        + ' — add the number to NOTIFY_ALLOWLIST to message it' };
  }

  return { ok: true, phones: normalised, message };
}

module.exports = { validate, normalisePhone, phoneLabel, allowlist,
  DEFAULT_ALLOWLIST, MAX_RECIPIENTS, MAX_MESSAGE_CHARS };
