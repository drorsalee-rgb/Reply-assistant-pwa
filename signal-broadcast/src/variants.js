// Rephrases a debunk into several distinct wordings, so the people drawn for
// one alert don't all post the identical sentence — which reads as a
// coordinated campaign and is exactly what platforms flag as inauthentic.
//
// Generation goes through the project's existing gemini-proxy service; no
// separate API key is involved.

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL
  || 'https://gemini-proxy-ru4qjbbrxa-ew.a.run.app';

// Cloud Run's metadata server mints an identity token for the proxy.
async function identityToken(audience){
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience='
      + encodeURIComponent(audience),
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if(!res.ok) throw new Error(`metadata identity token failed (${res.status})`);
  return res.text();
}

function buildPrompt(debunk, count, maxChars, claim, insist = false, postText = '', findings = []){
  const context = claim ? [
    'הטענה השקרית שאליה מתייחסת ההפרכה (להקשר בלבד — אין להפריך אותה מחדש):',
    claim,
    ''
  ] : [];
  // Facts a grounded search verified about this specific post. Only
  // contradictions reach here: anything the search confirmed or could not
  // settle was dropped before this point.
  const verified = findings.length ? [
    'עובדות שנבדקו בחיפוש מול מקורות, לגבי הטענות שהפוסט מוסיף:',
    ...findings.map((f, i) =>
      `${i + 1}. הפוסט טוען: ${f.postClaim}\n   בפועל: ${f.fact}\n   מקור: ${f.source}`),
    '',
    'שימוש בעובדות שנבדקו — קריטי:',
    '- מותר להשתמש בהן בתגובה. הן נבדקו מול מקורות.',
    '- אסור להרחיב אותן, להסיק מהן מסקנה נוספת, או לחדד ניגוד מעבר למה שכתוב.',
    '- אם עובדה שנבדקה מראה שהפוסט *מדייק* בנקודה מסוימת — אל תסתור אותה.',
    '- דיוק לפני חדות. עדיף לכתוב "אמר משהו אחר" מאשר לייחס לאדם אמירה שלא אמר.',
    '',
    '**שמירת סייגים — הכלל החשוב ביותר:**',
    '- עובדה שנבדקה מנוסחת בזהירות. אם היא כוללת סייג — "נכפתה", "נאלץ", "בעל כורחו",',
    '  "מטעמים פרגמטיים", "מבלי לוותר על" — **חובה לשמור אותו**. השמטת סייג הופכת',
    '  "קיבל בלית ברירה" ל"הסכים", וזו הצגה שקרית של עמדת אדם.',
    '- אם הסייג לא נכנס במגבלת התווים — **אל תשתמש בעובדה הזו בכלל**. ותר עליה',
    '  והישען על עובדות ההפרכה בלבד. ניסוח מדויק וצר עדיף על ניסוח רחב ומטעה.',
    '- אל תצטט אדם כאומר משהו חד יותר ממה שאמר בפועל.',
    ''
  ] : [];

  // When we have the actual post, the reply must talk to *it*, not to the
  // abstract claim: readers see the reply directly under that post.
  const postContext = postText ? [
    'הפוסט הספציפי שעליו מגיבים (התגובה תתפרסם ישירות מתחתיו):',
    postText,
    '',
    'התייחסות לפוסט — קריטי:',
    '- ענה ישירות למה שכתוב בפוסט הזה, בניסוח שמתכתב איתו, ולא רק לטענה הכללית.',
    '- אם הפוסט מוסיף טענות שאינן בטענה הבסיסית (למשל "אמר היום", "בערבית", ציטוט',
    '  ספציפי) — סתור או דייק אותן **רק** אם עובדות ההפרכה מאפשרות זאת.',
    '- טענה נוספת בפוסט שעובדות ההפרכה לא מכריעות — התעלם ממנה. אל תאשר, אל תכחיש',
    '  ואל תמציא עובדה כדי לענות עליה.',
    '- כשעובדות ההפרכה עומדות בסתירה מהותית לניסוח של הפוסט, פתח בהתייחסות ישירה',
    '  אליו — למשל: "בניגוד למה שנכתב כאן..." או ציטוט קצר מהפוסט והצמדת העובדה',
    '  שסותרת אותו. הקורא צריך להרגיש שהתגובה נכתבה לפוסט הזה, לא הודבקה אליו.',
    ''
  ] : [];
  const lengthRules = maxChars
    ? [
        `- **מגבלת אורך קשיחה: עד ${maxChars} תווים לגרסה** (כולל רווחים). זו מגבלת הרשת.`,
        '- אם המקור ארוך מכך, קצר: שמור את העובדה המרכזית שמפריכה את הטענה ואת מקור',
        '  ההפרכה, וותר על פרטי רקע משניים. עדיף הפרכה קצרה שנכנסת, מאשר ארוכה שנחתכת.',
        // The salvage attempt: every earlier try came back too long, so drop
        // everything except the one fact that refutes the claim.
        ...(insist ? [
          '',
          '**שים לב: כל הניסיונות הקודמים חרגו מהמגבלה ונפסלו.**',
          `הפעם קצר בצורה אגרסיבית. מותר לרדת עד ${Math.min(140, maxChars)} תווים.`,
          'השאר אך ורק את העובדה האחת שמפריכה את הטענה. ותר על כל השאר —',
          'רקע, הקשר, פירוט, ציטוטים, תאריכים משניים. משפט אחד או שניים בלבד.'
        ] : [])
      ]
    : ['- 30 עד 70 מילים לגרסה.'];

  return [
    'להלן טקסט הפרכה של טענה שקרית ברשת חברתית.',
    `נסח אותו מחדש ב-${count} גרסאות שונות בעברית, בשתי מקבילות: אחת לכותב זכר ואחת לכותבת נקבה.`,
    '',
    ...context,
    ...postContext,
    ...verified,
    'מי עשה מה — קריטי:',
    '- ציין תמיד **בשם מפורש** מי עשה את הפעולה שבהפרכה (מי הבטיח, מי אמר, מי פרסם).',
    '- אסור לפתוח ב״הוא״, ״היא״, ״הם״ או בפועל בלי נושא. קורא שרואה רק את השורה',
    '  הראשונה חייב לדעת על מי מדובר.',
    '- אם ההפרכה עצמה לא מציינת מי, ואפשר לקבוע זאת בוודאות מהטענה שלמעלה — כתוב את השם.',
    '- חריג: כשההפרכה עוסקת בזהות מזויפת עצמה — פרופיל פיקטיבי, חשבון מתחזה,',
    '  רשת בוטים או מסמך מפוברק — מפעיל הזהות אינו ידוע מעצם הטבע, ואין מה לציין.',
    '  במקרה כזה הנושא הוא הזהות המזויפת עצמה: ציין אותה בשמה (שם הפרופיל, הכינוי',
    '  או תיאור מזהה), וזה מספיק. אל תחזיר "subject_unclear".',
    '- אם ההפרכה מייחסת אמירה או מעשה לאדם אמיתי ואי אפשר לקבוע בוודאות מי הוא —',
    '  **אל תנחש**. רק במקרה כזה החזר "subject_unclear": true, והחזר רשימות ריקות.',
    '',
    'אורך:',
    ...lengthRules,
    '',
    'שמירה על העובדות:',
    '- אסור לסלף עובדה ואסור להוסיף עובדות, שמות או מספרים שאינם במקור.',
    '- שמור על שמות, תפקידים, גופים, כלי תקשורת, מספרים ותאריכים ככל שהאורך מאפשר.',
    '- מקור ההפרכה (מי חשף, איפה פורסם) חשוב במיוחד — השאר אותו אם אפשר.',
    '',
    'סגנון — קריטי:',
    '- זו תגובה של אדם פרטי ברשת חברתית ישראלית, לא הודעה רשמית ולא מכתב.',
    '- ישיר, קצר וחד. משפטים קצרים, עברית מדוברת, בגובה העיניים.',
    '- פתח ישר בעניין. אסור לפתוח ב״ברצוני״, ״הנני״, ״אבקש״ או ניסוח מליצי.',
    '- אסור להשתמש בביטויים משרדיים: ״יש לציין״, ״יש להבהיר״, ״ראוי לציין״,',
    '  ״לאור האמור״, ״בהתאם לכך״, ״אבקש להבהיר״, ״למען הסר ספק״.',
    '- מותר וטוב לומר בפשטות שהטענה שקרית. תוקפים את הטענה, לא מעליבים את האדם ולא מקללים.',
    '',
    'המשפט הראשון — הכי חשוב:',
    '- רוב הקוראים יקראו רק את השורה הראשונה, ולכן היא חייבת לשאת את **העובדה**',
    '  שמפריכה את הטענה — לא הצהרה כללית.',
    '- אל תפתח ב״הטענה הזו שקרית״, ״זה לא נכון״, ״מפיצים כאן שקר״ או דומיהן;',
    '  אפשר לומר זאת במשפט השני, אחרי שהעובדה כבר נאמרה.',
    '- דוגמה טובה: ״הסקר נערך בקרב כלל מצביעי הליכוד, לא בקרב המתפקדים',
    '  שמצביעים בפריימריז — הוא לא נועד לחזות אותם בכלל.״',
    '',
    'כללים נוספים:',
    '- ניסוח שונה בכל גרסה: מבנה משפט, סדר הצגת הדברים ואורך — כדי שלא ייראו כהעתקה.',
    '- הגרסה במקום ה-i ברשימת הזכר והגרסה במקום ה-i ברשימת הנקבה הן אותו ניסוח,',
    '  מותאם למגדר הכותב/ת. אם הניסוח ממילא נטול מגדר — החזר אותו טקסט בשתיהן.',
    '- בלי קישורים, בלי האשטגים, בלי אימוג׳י.',
    '- החזר JSON בלבד, ללא הסברים:',
    '  {"male":["...","..."],"female":["...","..."],"subject_unclear":false}',
    '',
    'טקסט ההפרכה:',
    debunk
  ].join('\n');
}

function cleanList(list){
  return (Array.isArray(list) ? list : [])
    .map(v => String(v || '').trim())
    .filter(Boolean);
}

// Returns { male: [...], female: [...] } with matching lengths, so index i is
// the same wording in either gender.
function parseVariants(responseText){
  const raw = String(responseText || '');
  // The model tends to wrap JSON in a ```json fence.
  const unfenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if(start === -1 || end === -1) return { male: [], female: [], subjectUnclear: false };
  let parsed;
  try{ parsed = JSON.parse(unfenced.slice(start, end + 1)); }
  catch(e){ return { male: [], female: [], subjectUnclear: false }; }

  const subjectUnclear = parsed.subject_unclear === true;

  // Tolerate the older single-list shape.
  if(Array.isArray(parsed.variants)){
    const list = cleanList(parsed.variants);
    return { male: list, female: list, subjectUnclear };
  }

  const male = cleanList(parsed.male);
  const female = cleanList(parsed.female);
  const size = Math.min(male.length || female.length, female.length || male.length);
  return {
    male: (male.length ? male : female).slice(0, size),
    female: (female.length ? female : male).slice(0, size),
    subjectUnclear
  };
}

// Words the rewrite must not quietly drop: anything with a digit, and the
// distinctive long words of the original (names, outlets, institutions).
// Common Hebrew connectives are too frequent to be evidence of anything.
const COMMON_WORDS = new Set([
  'למשפטנים', 'החלטות', 'פעולות', 'המידע', 'הטענה', 'הדברים', 'לפני', 'אינם',
  'אינה', 'אינו', 'שאין', 'מדובר', 'כאשר', 'בגלל', 'בלבד', 'אנשים', 'ולא'
]);

function keyTerms(text){
  const words = String(text || '').split(/[^\p{L}\p{N}"']+/u).filter(Boolean);
  const terms = new Set();
  for(const w of words){
    if(/\d/.test(w)){ terms.add(w); continue; }
    if(w.length >= 6 && !COMMON_WORDS.has(w)) terms.add(w);
  }
  return [...terms];
}

// Officialese that no one writes in a social media reply. A variant opening
// with any of these reads as a letter to a government office.
const STILTED_PHRASES = [
  'ברצוני', 'הנני', 'אבקש להבהיר', 'אבקש לציין', 'יש לציין', 'יש להבהיר',
  'ראוי לציין', 'למען הסר ספק', 'לאור האמור', 'בהתאם לכך', 'הריני'
];

// "הוא הבטיח…" reads as whoever the claim happened to mention last.
// (\b is ASCII-based in JavaScript and never matches at a Hebrew letter, so
// the boundary has to be spelled out.)
const PRONOUN_OPENERS = /^\s*(?:הוא|היא|הם|הן|זה|זו)(?=\s|$)/;

function namesTheActor(variant){
  return !PRONOUN_OPENERS.test(variant);
}

function soundsNatural(variant){
  return !STILTED_PHRASES.some(p => variant.includes(p));
}

// Most readers never get past the first line, so it has to carry the fact
// rather than a bare "that's false". A first sentence containing none of the
// original's distinctive terms is exactly that empty opener.
function startsWithFact(variant, terms){
  if(!terms.length) return true;
  const firstSentence = String(variant).split(/[.!?\n]/)[0] || '';
  if(firstSentence.trim().length < 15) return false;
  return terms.some(t => firstSentence.includes(t));
}

// How much of the original's detail a variant must carry. A same-length
// rewrite should keep most of it; one compressed to a quarter of the length
// physically cannot, so the bar scales with how much room it has. Measured
// against real output: a 650-char debunk squeezed into X's 280-character
// limit retains roughly 15–25% of the terms and is still a good debunk.
function keepsFacts(variant, terms, originalLength = 0){
  if(!terms.length) return true;
  const present = terms.filter(t => variant.includes(t)).length / terms.length;
  const lengthRatio = originalLength ? Math.min(1, variant.length / originalLength) : 1;
  const required = Math.max(0.12, 0.55 * lengthRatio);
  return present >= required;
}

// On 2026-09-03 a single gemini-proxy 500 aborted generation entirely: the
// fetch below threw, nothing caught it, and the alert that should have been
// refused (the debunk was 374 characters against a 256-character budget for
// X) instead went out to one volunteer as raw, unchecked text — because the
// "too long, refuse to send" safety check only ever ran when generation
// completed; a transient failure skipped it rather than triggering it.
//
// So a transient failure here must not look like "nothing fits" (which is
// what silently produced the unsafe fallback) or "give up instantly" (which
// wastes the many wordings the retry loop above this would have produced).
// It has to look like an ordinary failed attempt, retried a few times, and
// only surfaced once retrying stops helping.
const PROXY_RETRY_ATTEMPTS = Number(process.env.GEMINI_PROXY_RETRY_ATTEMPTS) || 3;
// Between attempts 1->2 and 2->3. Overridable so tests can simulate a
// sustained outage without a sustained wait.
const PROXY_RETRY_DELAYS_MS = (process.env.GEMINI_PROXY_RETRY_DELAY_MS || '1000,3000')
  .split(',').map(Number);

function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

async function callGeminiProxyOnce(prompt){
  const token = await identityToken(GEMINI_PROXY_URL);
  const res = await fetch(GEMINI_PROXY_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });
  if(!res.ok){
    const text = await res.text();
    const err = new Error(`gemini-proxy failed (${res.status}): ${text.slice(0, 200)}`);
    // 4xx means our own request was malformed — retrying sends the identical
    // bad request and just delays the inevitable. Only 5xx and network-level
    // failures (which never reach this branch; see the catch below) are the
    // "service is having a moment" case retrying is for.
    err.retryable = res.status >= 500;
    throw err;
  }
  return res.json();
}

async function callGeminiProxy(prompt){
  let lastErr;
  for(let attempt = 1; attempt <= PROXY_RETRY_ATTEMPTS; attempt++){
    try{
      return await callGeminiProxyOnce(prompt);
    }catch(e){
      lastErr = e;
      const retryable = e.retryable !== false;   // network errors carry no status; treat as retryable
      if(!retryable || attempt === PROXY_RETRY_ATTEMPTS) throw e;
      console.log(`gemini-proxy attempt ${attempt} failed (${e.message}); retrying in ${PROXY_RETRY_DELAYS_MS[attempt - 1]}ms`);
      await sleep(PROXY_RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw lastErr;
}

async function generateOnce(debunk, count, maxChars, claim, insist = false, postText = '', findings = []){
  if(!debunk || count < 1) return { male: [], female: [] };
  const data = await callGeminiProxy(buildPrompt(debunk, count, maxChars, claim, insist, postText, findings));
  const parsed = parseVariants(data.response);
  if(parsed.subjectUnclear){
    console.log('generation reported the debunk has no identifiable subject');
    return { male: [], female: [], subjectUnclear: true };
  }

  // Drop any pair whose male wording lost too much of the original detail.
  //
  // Grounded findings are a second legitimate source of facts: a wording that
  // answers what the post added, using a verified fact, is doing its job even
  // though it carries fewer of the debunk's own terms. Measuring it against
  // the debunk alone rejected exactly the wordings grounding exists to produce.
  const factBasis = findings.length
    ? debunk + ' ' + findings.map(f => f.fact).join(' ')
    : debunk;
  const terms = keyTerms(factBasis);
  const male = [];
  const female = [];
  parsed.male.forEach((text, i) => {
    if(maxChars && text.length > maxChars){
      console.log(`variant dropped: ${text.length} chars exceeds the ${maxChars} limit`);
      return;
    }
    if(!keepsFacts(text, terms, factBasis.length)){
      console.log('variant dropped: lost too many facts from the original');
      return;
    }
    if(!soundsNatural(text)){
      console.log('variant dropped: reads as officialese, not a social reply');
      return;
    }
    if(!startsWithFact(text, terms)){
      console.log('variant dropped: opens with a generic denial instead of the fact');
      return;
    }
    if(!namesTheActor(text)){
      console.log('variant dropped: opens with a pronoun, leaving the actor unnamed');
      return;
    }
    male.push(text);
    female.push(parsed.female[i] || text);
  });

  return { male, female, subjectUnclear: false };
}

// Two people must never be handed the same wording, so keep generating until
// there are at least `needed` distinct ones. Anything short of that limits
// how many people the alert can go to — see the caller.
async function generateVariants(debunk, needed, { maxAttempts = 5, maxChars = null, claim = '', postText = '', findings = [] } = {}){
  if(!debunk || needed < 1) return { male: [], female: [] };

  const male = [];
  const female = [];
  const seen = new Set();

  for(let attempt = 1; attempt <= maxAttempts && male.length < needed; attempt++){
    const missing = needed - male.length;
    let batch;
    try{
      // Ask for a couple of spares: some get rejected by the quality checks.
      batch = await generateOnce(debunk, Math.min(missing + 2, 8), maxChars, claim, false, postText, findings);
    }catch(e){
      // callGeminiProxy already retried the transient case internally; a
      // throw here means it gave up. Treated the same as "this attempt
      // produced nothing usable" rather than aborting generation outright —
      // that abort is exactly what let an unchecked, over-length debunk reach
      // a volunteer on 2026-09-03, by skipping the too-long check below
      // entirely instead of triggering it.
      console.error(`variant attempt ${attempt} failed: ${e.message}`);
      continue;
    }
    if(batch.subjectUnclear) return { male: [], female: [], subjectUnclear: true };
    batch.male.forEach((text, i) => {
      const key = text.replace(/\s+/g, ' ').trim();
      if(seen.has(key)) return;          // identical wording defeats the point
      seen.add(key);
      male.push(text);
      female.push(batch.female[i] || text);
    });
    if(!batch.male.length) console.log(`variant attempt ${attempt} produced nothing usable`);
  }

  if(!male.length){
    // The original is accurate, so where the network sets no limit — or the
    // original already fits — it stands on its own. One wording, so only one
    // person can receive it.
    if(!maxChars || debunk.length <= maxChars){
      return { male: [debunk], female: [debunk], subjectUnclear: false };
    }

    // The original cannot be posted here. Falling back to it would hand a
    // volunteer a reply the network rejects, so make one last attempt that
    // asks for nothing but brevity.
    console.log(`nothing fit ${maxChars} chars; one salvage attempt at a short wording`);
    let salvage = { male: [] };
    try{
      salvage = await generateOnce(debunk, 1, maxChars, claim, true, postText, findings);
    }catch(e){
      console.error(`salvage attempt failed: ${e.message}`);
    }
    if(salvage.male.length){
      console.log(`salvage produced a ${salvage.male[0].length}-character wording`);
      return { male: salvage.male, female: salvage.female, subjectUnclear: false };
    }

    // Still nothing. An alert nobody can act on is worse than no alert.
    console.log(`salvage failed: the ${debunk.length}-character debunk cannot be shortened to ${maxChars}`);
    return { male: [], female: [], subjectUnclear: false, tooLong: true };
  }
  return { male, female, subjectUnclear: false };
}

module.exports = { generateVariants, parseVariants, buildPrompt, keyTerms, keepsFacts, soundsNatural, startsWithFact, namesTheActor, callGeminiProxy };
