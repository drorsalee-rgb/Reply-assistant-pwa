// Translates a post's own text to Hebrew before it reaches a volunteer who
// is being asked to judge or rebut it in Hebrew.
//
// Two real incidents landed on 2026-09-03, both in the same code, hours
// apart:
//
//   1. A borderline alert quoted an Arabic post verbatim. The check gating
//      translation only looked for Latin letters, so Arabic — which has
//      none — was invisible to it and nothing was ever translated.
//
//   2. After (1) was fixed with sl=auto, a video-post summary went out in
//      English untouched. The summary quoted a couple of sentences of
//      Hebrew dialogue from its subjects; Google's language detector looked
//      at the whole blob, found real Hebrew in it, and called the SOURCE
//      language Hebrew. sl=auto became sl=he, translating Hebrew to
//      Hebrew — a no-op that handed back the English text completely
//      unchanged. Nothing errored: the request succeeded and returned a
//      non-empty string, so it sailed straight past the one check
//      (`if (translated)`) guarding it.
//
// Fixed by not trusting a detector on mixed-language text at all: pick the
// source language from which script actually dominates (we already know
// translation is needed at this point, and roughly what the text looks
// like), and verify the OUTPUT actually reads as Hebrew before trusting it —
// a translation that still looks untranslated is treated as a failure, not
// a success, whatever the API's status code said.

// Any script that isn't Hebrew counts as needing translation — not just
// Latin, which is what let incident (1) through.
function needsTranslation(text){
  const hebrew = (text.match(/[֐-׿]/g) || []).length;
  const other = (text.match(/\p{L}/gu) || []).length - hebrew;
  return other > 0 && hebrew / (hebrew + other) < 0.34;
}

function dominantForeignScript(text){
  const arabic = (text.match(/[؀-ۿ]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) || []).length;
  const best = Math.max(arabic, latin, cyrillic);
  if(best === 0) return 'auto';
  if(best === arabic) return 'ar';
  if(best === cyrillic) return 'ru';
  return 'en';
}

/**
 * @returns {Promise<string|null>} the Hebrew translation, or null when
 *   translation failed OR produced something that still isn't Hebrew —
 *   the caller's fallback (usually: send the original) is the same either way.
 */
async function translateToHebrew(text){
  try{
    const source = text.slice(0, 1500);   // keep the request URL sane
    const sl = dominantForeignScript(source);
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=he&dt=t&q=`
      + encodeURIComponent(source));
    if(!res.ok) return null;
    const data = await res.json();
    const out = (data[0] || []).map(seg => seg[0]).filter(Boolean).join('');
    if(!out) return null;
    if(needsTranslation(out)){
      console.log('translation returned non-Hebrew output (likely a source-language misdetection); treating as failed');
      return null;
    }
    return out;
  }catch(e){
    return null;
  }
}

module.exports = { needsTranslation, dominantForeignScript, translateToHebrew };
