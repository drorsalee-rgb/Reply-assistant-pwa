// A one-line description of the post being answered, for the debunk PWA.
//
// The PWA used to show the engine's `claim` field there. That field is written
// as an abstract proposition and often arrives without a subject — "אמר
// שישראל היא ישות זמנית" with no indication of who said it — so a reader
// opening the alert could not tell what they were about to reply to.
//
// This produces the missing sentence: what the post itself says, with its
// subject named. It is deliberately NOT a rebuttal; the rebuttal is the card
// below it on the page.
//
// Generation goes through the same gemini-proxy as the wordings. A failure
// here is not worth failing an alert over — the caller falls back to the
// claim, which is what the page showed before.

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL
  || 'https://gemini-proxy-ru4qjbbrxa-ew.a.run.app';

// Long enough for a real sentence with a subject, short enough that the card
// stays a glance rather than a read.
const MAX_CHARS = 220;

async function identityToken(audience){
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience='
      + encodeURIComponent(audience),
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if(!res.ok) throw new Error(`metadata identity token failed (${res.status})`);
  return res.text();
}

function buildSummaryPrompt(postText, claim){
  const claimContext = claim ? [
    'הטענה שזוהתה בפוסט (מנוסחת בצורה מופשטת, ולעיתים חסר בה הנושא):',
    claim,
    ''
  ] : [];

  return [
    'לפניך טקסט של פוסט ברשת חברתית שזוהה כמטעה.',
    'כתוב משפט אחד בעברית שמתאר מה הפוסט אומר.',
    '',
    ...claimContext,
    'טקסט הפוסט:',
    postText,
    '',
    'כללים:',
    '- משפט אחד, עד ' + MAX_CHARS + ' תווים.',
    '- חובה לציין במפורש מי אומר או מי עושה. אם הפוסט מייחס אמירה לאדם או לגוף — נקוב בשמו.',
    '- אסור להתחיל בכינוי גוף ("הוא", "הם") או בפועל בלי נושא.',
    '- אם מהפוסט לא ברור מי הנושא, כתוב "הפוסט טוען" והמשך משם.',
    '- זהו תיאור, לא הפרכה. אל תתקן, אל תסתור ואל תוסיף עובדות.',
    '- נסח כך שברור שזו טענת הפוסט ולא עובדה: פתח ב"הפוסט טוען ש..." או "לפי הפוסט...".',
    '- ללא מרכאות, ללא markdown, ללא הקדמה. החזר את המשפט בלבד.'
  ].join('\n');
}

// Models like to wrap a single-sentence answer in quotes or a label.
function cleanSummary(text){
  return String(text || '')
    .replace(/^\s*(סיכום|תקציר|תשובה)\s*:\s*/i, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^["'״]+|["'״]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A summary that opens with a bare pronoun or verb reintroduces exactly the
// subjectless problem this function exists to solve, so it is not worth
// publishing — the caller falls back rather than showing it.
function hasSubject(text){
  // \b is defined over [A-Za-z0-9_], so it never matches between two Hebrew
  // letters — a lookahead for whitespace or end of string is the equivalent.
  return !/^\s*(הוא|היא|הם|הן|אמר|אמרה|טען|טענה|הצהיר|הצהירה|קרא|קראה)(?=\s|$)/.test(text);
}

/**
 * @returns {Promise<string|null>} the sentence, or null to fall back to the claim.
 */
async function summarisePost(postText, claim, rid = ''){
  const source = String(postText || '').trim();
  if(!source) return null;

  try{
    const token = await identityToken(GEMINI_PROXY_URL);
    const res = await fetch(GEMINI_PROXY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      // The whole post is more context than a one-liner needs, and a very long
      // post would push the request past what the proxy accepts.
      body: JSON.stringify({ prompt: buildSummaryPrompt(source.slice(0, 4000), claim) })
    });
    if(!res.ok){
      const text = await res.text();
      console.log(rid, `post summary failed (${res.status}): ${text.slice(0, 120)}`);
      return null;
    }
    const data = await res.json();
    const summary = cleanSummary(data.response);
    if(!summary){
      console.log(rid, 'post summary came back empty; falling back to the claim');
      return null;
    }
    if(!hasSubject(summary)){
      console.log(rid, 'post summary has no subject; falling back to the claim');
      return null;
    }
    return summary.length > MAX_CHARS
      ? summary.slice(0, MAX_CHARS - 1).trimEnd() + '…'
      : summary;
  }catch(e){
    console.log(rid, 'post summary failed:', e.message);
    return null;
  }
}

/**
 * The summary to use for one alert.
 *
 * The fake-finding server's own sentence wins when it sends one, for the same
 * reason its wordings do: it is written against the full post and the verified
 * evidence, neither of which reaches us. It still has to name a subject — a
 * summary opening with a bare pronoun reintroduces exactly the problem this
 * replaced — and we generate our own when it doesn't.
 *
 * @returns {Promise<string|null>} null when there is nothing to show, and the
 *   caller should fall back to the claim.
 */
async function resolvePostSummary(providedSummary, postText, claim, rid = ''){
  const provided = String(providedSummary || '').trim();
  if(provided){
    if(hasSubject(provided)){
      console.log(rid, 'using the upstream post summary');
      return provided;
    }
    console.log(rid, 'upstream post summary has no subject; generating our own');
  }
  return summarisePost(postText, claim, rid);
}

module.exports = { summarisePost, resolvePostSummary, buildSummaryPrompt,
  cleanSummary, hasSubject, MAX_CHARS };
