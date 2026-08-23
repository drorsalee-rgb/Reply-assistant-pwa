// Parses the free-text WhatsApp message a Fake Hunting participant sends to
// choose which networks they want alerts for — and to change or stop them
// later. People write casually ("רק פייסבוק ואינסטה", "בטיקטוק"), so matching
// is deliberately forgiving.

const NETWORK_KEYWORDS = {
  // Hebrew keywords match anywhere (prefixes like ב־/ו־ are common);
  // latin ones must stand alone, so "ig" can't match inside another word.
  x:         { hebrew: ['אקס', 'טוויטר', 'טויטר'], latin: ['x', 'twitter'] },
  facebook:  { hebrew: ['פייסבוק', 'פייס'],        latin: ['facebook', 'fb'] },
  instagram: { hebrew: ['אינסטגרם', 'אינסטה'],     latin: ['instagram', 'insta', 'ig'] },
  tiktok:    { hebrew: ['טיקטוק', 'טיק טוק'],      latin: ['tiktok'] },
  youtube:   { hebrew: ['יוטיוב'],                 latin: ['youtube', 'yt'] },
  linkedin:  { hebrew: ['לינקדאין', 'לינקדין'],    latin: ['linkedin'] }
};

const ALL_NETWORKS = Object.keys(NETWORK_KEYWORDS);
const ALL_WORDS = ['הכל', 'הכול', 'כולם', 'כל הרשתות', 'all', 'everything'];
const STOP_WORDS = ['הסר', 'הסירו', 'הסירי', 'עצור', 'עצרו', 'הפסק', 'הפסיקו',
                    'ביטול', 'בטל', 'בטלו', 'stop', 'unsubscribe', 'remove'];

function tokens(text){
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function parseMessage(text){
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const words = tokens(raw);

  if(STOP_WORDS.some(w => words.includes(w))){
    return { action: 'stop', networks: [] };
  }

  const found = ALL_NETWORKS.filter(network => {
    const { hebrew, latin } = NETWORK_KEYWORDS[network];
    return hebrew.some(k => lower.includes(k)) || latin.some(k => words.includes(k));
  });
  if(found.length) return { action: 'set', networks: found };

  if(ALL_WORDS.some(w => lower.includes(w))){
    return { action: 'set', networks: [...ALL_NETWORKS] };
  }

  // Someone just said hello, or wrote something we don't recognise. Joining
  // still counts — they simply get everything until they narrow it down.
  return { action: 'unknown', networks: [] };
}

const NETWORK_HE = {
  x: 'X', facebook: 'פייסבוק', instagram: 'אינסטגרם',
  tiktok: 'טיקטוק', youtube: 'יוטיוב', linkedin: 'לינקדאין'
};

function networkNames(networks){
  const list = networks && networks.length ? networks : ALL_NETWORKS;
  return list.map(n => NETWORK_HE[n] || n).join(', ');
}

const HOW_TO_CHANGE =
  'לשינוי, שלחו לי הודעה עם שמות הרשתות שמעניינות אתכם — למשל "פייסבוק ואינסטגרם".\n' +
  'לקבלת הכול: "הכל". להפסקת ההודעות: "הסר".';

function confirmationMessage({ action, networks }, { isNew = false } = {}){
  if(action === 'stop'){
    return 'הוסרת מרשימת ההתראות ולא תקבל/י מאיתנו הודעות נוספות. ' +
           'אם תשנה/י את דעתך, שלח/י לי הודעה עם שמות הרשתות שמעניינות אותך.';
  }
  const opening = isNew ? 'נרשמת להתראות על פייקים 🎯' : 'עודכן ✅';
  const scope = (!networks || !networks.length || networks.length === ALL_NETWORKS.length)
    ? 'תקבל/י התראות על **כל הרשתות**.'
    : `תקבל/י התראות על: **${networkNames(networks)}**.`;
  return `${opening}\n\n${scope}\n\n${HOW_TO_CHANGE}`;
}

module.exports = { parseMessage, confirmationMessage, networkNames, ALL_NETWORKS };
