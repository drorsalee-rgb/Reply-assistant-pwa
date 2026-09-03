// Parses the free-text WhatsApp message a Fake Hunting participant sends to
// choose which networks they want alerts for — and to change or stop them
// later. People write casually ("רק פייסבוק ואינסטה", "בטיקטוק"), so matching
// is deliberately forgiving.

const NETWORK_KEYWORDS = {
  // Hebrew keywords match anywhere (prefixes like ב־/ו־ are common);
  // latin ones must stand alone, so "ig" can't match inside another word.
  x:         { hebrew: ['איקס', 'אקס', 'טוויטר', 'טויטר'], latin: ['x', 'twitter'] },
  facebook:  { hebrew: ['פייסבוק', 'פייס'],        latin: ['facebook', 'fb'] },
  instagram: { hebrew: ['אינסטגרם', 'אינסטה'],     latin: ['instagram', 'insta', 'ig'] },
  tiktok:    { hebrew: ['טיקטוק', 'טיק טוק'],      latin: ['tiktok'] },
  youtube:   { hebrew: ['יוטיוב'],                 latin: ['youtube', 'yt'] },
  linkedin:  { hebrew: ['לינקדאין', 'לינקדין'],    latin: ['linkedin'] }
};

const ALL_NETWORKS = Object.keys(NETWORK_KEYWORDS);
// "הכל" — and joining without naming anything — covers the networks we
// actually campaign on. YouTube and LinkedIn are recognised if someone asks
// for them by name, but nobody is signed up for them by default.
const DEFAULT_NETWORKS = ['x', 'facebook', 'instagram', 'tiktok'];
const ALL_WORDS = ['הכל', 'הכול', 'כולם', 'כל הרשתות', 'all', 'everything'];
const STOP_WORDS = ['הסר', 'הסירו', 'הסירי', 'עצור', 'עצרו', 'הפסק', 'הפסיקו',
                    'ביטול', 'בטל', 'בטלו', 'stop', 'unsubscribe', 'remove'];

// Borderline posts are the ones the fake-finding server is NOT confident
// about. They go only to volunteers who asked for them, because the task is
// different: judging whether the suggested reply actually fits the post,
// rather than posting a ready rebuttal.
const BORDERLINE_ON_WORDS  = ['גבולי', 'גבוליים', 'בדיקה', 'בדיקות', 'חוות דעת', 'לבדוק'];
const BORDERLINE_OFF_WORDS = ['בלי גבולי', 'בלי בדיקות', 'בלי בדיקה', 'לא גבולי', 'לא בדיקות'];

function tokens(text){
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function parseMessage(text){
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const words = tokens(raw);

  if(STOP_WORDS.some(w => words.includes(w))){
    return { action: 'stop', networks: [], borderline: null };
  }

  // Checked before the ON words, so "בלי בדיקות" is not read as asking for
  // them. Absent from the message means "leave it as it is", not "turn off" —
  // someone changing only their networks must not silently lose this.
  const borderline = BORDERLINE_OFF_WORDS.some(w => lower.includes(w)) ? false
    : (BORDERLINE_ON_WORDS.some(w => lower.includes(w)) ? true : null);

  const found = ALL_NETWORKS.filter(network => {
    const { hebrew, latin } = NETWORK_KEYWORDS[network];
    return hebrew.some(k => lower.includes(k)) || latin.some(k => words.includes(k));
  });
  if(found.length) return { action: 'set', networks: found, borderline };

  if(ALL_WORDS.some(w => lower.includes(w))){
    return { action: 'set', networks: [...DEFAULT_NETWORKS], borderline };
  }

  // Only a borderline instruction, with no network named: a preference change,
  // not a new registration scope.
  if(borderline !== null) return { action: 'set', networks: [], borderline };

  // Someone just said hello, or wrote something we don't recognise. Joining
  // still counts — they simply get everything until they narrow it down.
  return { action: 'unknown', networks: [], borderline: null };
}

const NETWORK_HE = {
  x: 'X', facebook: 'פייסבוק', instagram: 'אינסטגרם',
  tiktok: 'טיקטוק', youtube: 'יוטיוב', linkedin: 'לינקדאין'
};

function networkNames(networks){
  const list = networks && networks.length ? networks : DEFAULT_NETWORKS;
  return list.map(n => NETWORK_HE[n] || n).join(', ');
}

const HOW_TO_CHANGE =
  'לשינוי, שלחו לי הודעה עם שמות הרשתות שמעניינות אתכם — למשל "פייסבוק ואינסטגרם".\n' +
  'לקבלת הכול: "הכל". להפסקת ההודעות: "הסר".\n' +
  'לקבלת פוסטים גבוליים שדורשים חוות דעת: "בדיקות".';

function borderlineLine(borderline){
  if(borderline === true){
    return '\n\n🔍 תקבל/י גם **פוסטים גבוליים** — כאלה שהמערכת לא בטוחה לגביהם. ' +
      'שם המשימה שונה: לבדוק אם התגובה המוצעת מתאימה לפוסט, ולומר לנו. ' +
      'זה מה שמשפר את המערכת.';
  }
  if(borderline === false){
    return '\n\nלא תקבל/י יותר פוסטים גבוליים.';
  }
  return '';
}

function confirmationMessage({ action, networks, borderline }, { isNew = false } = {}){
  if(action === 'stop'){
    return 'הוסרת מרשימת ההתראות ולא תקבל/י מאיתנו הודעות נוספות. ' +
           'אם תשנה/י את דעתך, שלח/י לי הודעה עם שמות הרשתות שמעניינות אותך.';
  }
  const opening = isNew ? 'נרשמת להתראות על פייקים 🎯' : 'עודכן ✅';
  const coversDefault = !networks || !networks.length
    || DEFAULT_NETWORKS.every(n => networks.includes(n));
  const scope = coversDefault
    ? `תקבל/י התראות על **כל הרשתות**: ${networkNames(networks)}.`
    : `תקבל/י התראות על: **${networkNames(networks)}**.`;
  return `${opening}\n\n${scope}${borderlineLine(borderline)}\n\n${HOW_TO_CHANGE}`;
}

// What an already-registered person is signed up for, read from their stored
// document rather than re-derived — this must show what IS, never write
// anything.
//
// Exists because an unclear message from a known number used to fall through
// to recordOptIn with networks:[], which is read downstream as "every
// network" and silently overwrote a deliberate choice like "X only" with the
// full default set. The fix is this: a registered person who sends something
// we cannot parse gets told what they are currently signed up for, and
// nothing is written. That directly answers the question this exists to
// answer ("which network am I even registered under?") instead of quietly
// changing the answer.
function statusMessage(optin){
  // Removal only ever flips `active`; the old `networks` value is left in the
  // document. Reporting it here would tell someone we already removed that
  // they are still signed up.
  if(optin.active === false){
    return 'לא רשום/ה אצלנו כרגע לקבלת התראות. ' + HOW_TO_CHANGE;
  }
  const networks = Array.isArray(optin.networks) ? optin.networks : [];
  const coversDefault = !networks.length
    || DEFAULT_NETWORKS.every(n => networks.includes(n));
  const scope = coversDefault
    ? `את/ה רשום/ה לקבל התראות על **כל הרשתות**: ${networkNames(networks)}.`
    : `את/ה רשום/ה לקבל התראות על: **${networkNames(networks)}**.`;
  return `הנה מה שרשום אצלנו עבורך כרגע:\n\n${scope}` +
    `${borderlineLine(optin.borderline === true ? true : null)}\n\n${HOW_TO_CHANGE}`;
}

// Someone whose message we could not parse has not asked to join — they may be
// asking what this is. Registering them anyway and announcing "you are signed
// up" is how a volunteer came to receive a fake-hunting alert she never
// requested. Explain instead, and let the next message be the actual consent.
function invitationMessage(){
  return 'היי! אני הבוט של *יוריקי* 👋\n\n' +
    'אני שולח למתנדבים התראות על פוסטים שמפיצים מידע כוזב, יחד עם הפרכה מוכנה ' +
    'להעתקה — כדי שאפשר יהיה להגיב מהר.\n\n' +
    'רוצה לקבל התראות? כתוב/כתבי לי אילו רשתות מעניינות אותך — למשל ' +
    '"פייסבוק ואינסטגרם", או "הכל".\n\n' +
    'לא רשמתי אותך לשום דבר עדיין.';
}

module.exports = { parseMessage, confirmationMessage, invitationMessage, statusMessage, networkNames, ALL_NETWORKS, DEFAULT_NETWORKS };
