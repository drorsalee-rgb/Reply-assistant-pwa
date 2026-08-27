// Grounded fact-checking of what a specific post adds on top of the base fake.
//
// The fact-checking team's debunk answers the underlying claim. The post that
// volunteers actually reply to often asserts more than that — a date, a
// language, a venue, a quote — and a reply that ignores those additions reads
// as pasted on. This asks Gemini, with Google Search grounding, what is
// actually true about them.
//
// Called directly rather than through gemini-proxy: the proxy sends a bare
// prompt with no tools, is shared with other callers, and grounding needs both
// the tool declaration and the source metadata that comes back with it.

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'torino-social';
const LOCATION = process.env.VERTEX_LOCATION || 'europe-west1';
const MODEL = process.env.GROUNDING_MODEL || 'gemini-2.5-flash';

const ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}`
  + `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

// Cloud Run's metadata server mints tokens for the runtime service account.
let cachedToken = { value: null, expiresAt: 0 };

async function accessToken(){
  if(cachedToken.value && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if(!res.ok) throw new Error(`metadata token failed (${res.status})`);
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in || 60) - 30, 10) * 1000
  };
  return cachedToken.value;
}

function buildPrompt(claim, debunk, postText){
  return [
    'אתה בודק עובדות. לפניך פוסט ברשת חברתית, טענה שקרית ידועה, והפרכה שכתב צוות בדיקת עובדות.',
    '',
    'הטענה השקרית הידועה:',
    claim || '(לא סופקה)',
    '',
    'ההפרכה של צוות בדיקת העובדות:',
    debunk,
    '',
    'הפוסט שעליו מגיבים:',
    postText,
    '',
    'המשימה: זהה טענות עובדתיות שהפוסט מוסיף מעבר לטענה הידועה — למשל תאריך,',
    'שפה, מקום, ציטוט, או ייחוס אמירה לאדם. לכל אחת, בדוק בחיפוש מה קרה בפועל.',
    '',
    'כללים קשיחים:',
    '- הסתמך אך ורק על מקורות שמצאת בחיפוש. אל תסתמך על זיכרון.',
    '- אם לא מצאת מקור אמין לטענה — סווג אותה "unverified". אל תנחש.',
    '- דייק בציטוטים. אם אדם אמר משהו שונה ממה שהפוסט מייחס לו, כתוב מה הוא אמר בפועל.',
    '- הבחן בין "אמר את ההפך" לבין "אמר משהו אחר בניואנס". אל תחדד ניגוד שלא קיים.',
    '',
    'החזר JSON בלבד:',
    '{"findings":[{"postClaim":"מה הפוסט טוען","verdict":"false|true|unverified",',
    ' "fact":"מה קרה בפועל, במשפט אחד, רק אם verdict הוא false","source":"כתובת המקור"}]}',
    '',
    'אם אין טענות נוספות מעבר לטענה הידועה — החזר {"findings":[]}.'
  ].join('\n');
}

function parseFindings(text){
  const unfenced = String(text || '').replace(/```json|```/g, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if(start === -1 || end === -1) return [];
  let parsed;
  try{ parsed = JSON.parse(unfenced.slice(start, end + 1)); }
  catch(e){ return []; }
  if(!Array.isArray(parsed.findings)) return [];

  return parsed.findings
    // Only contradictions are usable. "true" means the post is right about
    // that point, and "unverified" means we don't know — publishing either as
    // a correction would be wrong.
    .filter(f => f && f.verdict === 'false' && f.fact && f.source)
    .map(f => ({
      postClaim: String(f.postClaim || '').slice(0, 300),
      fact: String(f.fact).slice(0, 400),
      source: String(f.source).slice(0, 300)
    }))
    .slice(0, 4);
}

/**
 * @param {string} claim
 * @param {string} debunk
 * @param {string} postText
 * @returns {Promise<{findings: object[], sources: string[]}>}
 */
async function checkPostClaims(claim, debunk, postText){
  if(!postText) return { findings: [], sources: [] };

  const token = await accessToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(claim, debunk, postText) }] }],
      tools: [{ googleSearch: {} }]
    })
  });
  if(!res.ok){
    const body = await res.text();
    throw new Error(`vertex grounding failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const candidate = (data.candidates || [])[0] || {};
  const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
  const chunks = candidate.groundingMetadata?.groundingChunks || [];

  // Kept for the record: which pages the model actually consulted, separate
  // from the source it chose to cite per finding.
  const sources = chunks
    .map(c => c.web?.uri || c.retrievedContext?.uri || '')
    .filter(Boolean)
    .slice(0, 10);

  return { findings: parseFindings(text), sources };
}

module.exports = { checkPostClaims, parseFindings, buildPrompt };
