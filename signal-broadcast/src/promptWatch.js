// Notices when the editable prompt intro changes, and keeps the previous copy.
//
// `prompt-constants/shared.introParallel` is the opening paragraph of the
// prompt that generates every reply suggestion — the first thing the model
// reads, and so the strongest place to inject instructions. It sits in the
// default1 database, where the Firestore rules still allow an unauthenticated
// write: the dashboard's prompt editor reaches it with no token, and until the
// dashboard can authenticate (takephone/yoriki-dash#3) requiring auth would
// take that editor away from the person using it daily.
//
// So this does not prevent a change. It makes one impossible to miss, and
// makes undoing it a copy-paste:
//   - compares the live value against the last one seen
//   - stores the previous text before recording the new one
//   - sends the operator one WhatsApp naming what changed and by how much
//
// Legitimate edits fire it too. That is intended — an alert saying the prompt
// changed is exactly right, and the operator knows whether it was expected.

const WATCH_COLLECTION = 'prompt-watch';
const WATCHED = [
  { db: 'default1', collection: 'prompt-constants',         label: 'ייצור' },
  { db: 'default1', collection: 'prompt-constants_staging', label: 'סטייג׳ינג' },
];
const DOC_ID = 'shared';
const FIELD = 'introParallel';

function sha256(text) {
  return require('crypto').createHash('sha256').update(text || '', 'utf8').digest('hex');
}

// A first line or two is enough for an operator to recognise a rewrite; the
// whole 17k-character prompt does not belong in a WhatsApp message.
function preview(text, max = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max) + '…';
}

/**
 * @param {import('@google-cloud/firestore').Firestore} watchDb
 *   where the baseline is stored (the default database)
 * @param {(dbId: string) => import('@google-cloud/firestore').Firestore} dbFor
 * @param {(key: string, text: string, rid: string, opts?: object) => Promise<void>} sendAlert
 * @returns {Promise<Array<{collection: string, status: string}>>}
 */
async function checkPrompts(watchDb, dbFor, sendAlert, rid = '') {
  const results = [];

  for (const target of WATCHED) {
    const key = `${target.db}__${target.collection}`;
    try {
      const snap = await dbFor(target.db).collection(target.collection).doc(DOC_ID).get();
      const current = snap.exists ? (snap.data()[FIELD] || '') : '';
      const hash = sha256(current);

      const ref = watchDb.collection(WATCH_COLLECTION).doc(key);
      const seen = await ref.get();

      if (!seen.exists) {
        // First run: record a baseline, say nothing. Alerting here would just
        // announce that the watch started.
        await ref.set({
          hash, text: current, length: current.length,
          collection: target.collection, database: target.db,
          checkedAt: new Date(),
        });
        results.push({ collection: target.collection, status: 'baseline' });
        continue;
      }

      const prev = seen.data();
      if (prev.hash === hash) {
        await ref.set({ checkedAt: new Date() }, { merge: true });
        results.push({ collection: target.collection, status: 'unchanged' });
        continue;
      }

      // Keep the text we are replacing BEFORE overwriting the baseline, so the
      // previous version is always recoverable from Firestore.
      await ref.set({
        hash, text: current, length: current.length,
        collection: target.collection, database: target.db,
        previousText: prev.text || '', previousLength: prev.length || 0,
        changedAt: new Date(), checkedAt: new Date(),
      });

      const delta = current.length - (prev.length || 0);
      await sendAlert(`prompt-changed:${key}`,
        `הפרומפט (${target.label}) השתנה.\n\n`
        + `אורך: ${prev.length || 0} → ${current.length} תווים (${delta >= 0 ? '+' : ''}${delta})\n\n`
        + `הפתיחה החדשה:\n${preview(current)}\n\n`
        + `אם זו לא הייתה עריכה מתוכננת — הגרסה הקודמת שמורה במלואה ב-`
        + `${WATCH_COLLECTION}/${key}, בשדה previousText.`,
        rid, { title: 'הפרומפט השתנה', footer: '' });

      results.push({ collection: target.collection, status: 'changed', delta });
    } catch (e) {
      console.error(rid, `prompt watch failed for ${key}:`, e.message);
      results.push({ collection: target.collection, status: 'error', error: e.message });
    }
  }

  return results;
}

module.exports = { checkPrompts, sha256, preview, WATCH_COLLECTION, WATCHED };
