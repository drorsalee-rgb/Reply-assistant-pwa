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
//      English untouched — reproducible from a laptop as a source-language
//      misdetection, so that is what was "fixed" next.
//
// Both diagnoses were wrong about where the failure was. On 2026-09-04 a
// third report prompted a look at the actual production logs, which show
// something neither incident investigation had checked: 90+ consecutive
// "translation failed" lines from 2026-08-23 onwards, with ZERO successes.
// Translation had never worked in production at all. Both earlier fixes
// changed logic that never got the chance to run.
//
// The lesson worth keeping: reproducing a bug locally is not the same as
// diagnosing it, and "did this code path ever succeed in production?" is a
// cheaper question than either investigation that skipped it.

// Any script that isn't Hebrew counts as needing translation — not just
// Latin, which is what let incident (1) through.
function needsTranslation(text){
  const hebrew = (text.match(/[֐-׿]/g) || []).length;
  const other = (text.match(/\p{L}/gu) || []).length - hebrew;
  return other > 0 && hebrew / (hebrew + other) < 0.34;
}

// Translation goes through the project's own gemini-proxy, NOT
// translate.googleapis.com/translate_a/single.
//
// That endpoint is the undocumented one the web UI uses. It works fine from a
// laptop and has never once succeeded from Cloud Run: the logs show 90+
// consecutive "translation failed" lines from 2026-08-23 to 2026-09-04 with
// zero successes. Both of the "fixes" made on 2026-09-03 — widening the
// script check, then pinning the source language — were changes to logic that
// never got the chance to run, because the HTTP call itself always failed.
// The most likely reason is that Google blocks that endpoint from datacenter
// IP ranges, but the exact cause hardly matters: it cannot be relied on from
// where this service runs.
//
// gemini-proxy is already used by this service for wording generation, dozens
// of times a day, successfully, from the same Cloud Run instances. It is
// already authenticated, already budgeted, and an LLM handles the
// mixed-language case (an English report quoting Hebrew speakers) better than
// a language detector does — which was the whole subject of the second
// 2026-09-03 incident.
const { callGeminiProxy } = require('./variants');

function buildTranslationPrompt(text){
  return [
    'תרגם את הטקסט הבא לעברית.',
    '',
    'כללים:',
    '- החזר אך ורק את התרגום עצמו, בלי הקדמה, בלי הערות ובלי מרכאות עוטפות.',
    '- שמור על מבנה השורות והתבליטים של המקור.',
    '- קטעים שכבר כתובים בעברית — העתק אותם כמו שהם, בלי לשנות מילה.',
    '- שמות של אנשים, ארגונים וכלי תקשורת — תעתק לעברית כמקובל.',
    '',
    'הטקסט:',
    text
  ].join('\n');
}

/**
 * @returns {Promise<string|null>} the Hebrew translation, or null when
 *   translation failed OR produced something that still isn't Hebrew —
 *   the caller's fallback (usually: send the original) is the same either way.
 */
async function translateToHebrew(text){
  try{
    const source = text.slice(0, 4000);
    const data = await callGeminiProxy(buildTranslationPrompt(source));
    const out = String(data.response || '').trim();
    if(!out) return null;
    // Kept from the 2026-09-03 fix and still worth having: verify the OUTPUT
    // actually reads as Hebrew. A model that echoes its input, or answers in
    // the source language, fails the same way the old no-op did — and the
    // caller's fallback is identical either way.
    if(needsTranslation(out)){
      console.log('translation returned non-Hebrew output; treating as failed');
      return null;
    }
    return out;
  }catch(e){
    console.log('translation failed:', e.message);
    return null;
  }
}

module.exports = { needsTranslation, translateToHebrew, buildTranslationPrompt };
