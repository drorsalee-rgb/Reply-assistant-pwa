// pwa-events — counts what users do in the Yoriki Light PWA.
//
// Deliberately minimal and privacy-preserving: no cookies, no user ids, no
// IPs, no third-party scripts. Only aggregate counters per post document,
// plus a per-session marker (a random per-tab string) so repeat renders of
// the same session aren't counted as new opens.
//
// Public (unauthenticated) by necessity — it's called from users' browsers.
// Guards: fixed event whitelist, length caps, and an allowed-origin check.

const express = require('express');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { appendReport } = require('./sheet');
const { clientIp, overLimit } = require('./rateLimit');
const { pushOutcome, isConfigured: outcomesConfigured } = require('./outcomes');

const db = new Firestore();
const app = express();
// Beacons arrive as text/plain (that avoids a CORS preflight), so accept any
// content type and parse the body ourselves.
app.use(express.text({ type: '*/*', limit: '4kb' }));

const STATS = 'pwa-stats';
const FEEDBACK = 'debunk-feedback';
// Set once the sheet exists and is shared with this service's account.
const SHEET_ID = process.env.FEEDBACK_SHEET_ID || '';

// Only these reasons are accepted; anything else is dropped rather than stored.
const REPORT_REASONS = {
  post_wont_open: 'הפוסט המקורי לא נפתח',
  replies_disabled: 'הפוסט לא מאפשר תגובות',
  not_fake: 'זה לא באמת פייק',
  reply_mismatch: 'התגובה לא מתאימה לפוסט',
  // Verdicts on a borderline post — one the fake-finding server was not
  // confident about. Unlike the reasons above these are not complaints; they
  // are the answer we asked for, and both directions are worth recording.
  borderline_fits: 'פוסט גבולי — התגובה מתאימה',
  borderline_does_not_fit: 'פוסט גבולי — התגובה לא מתאימה',
};
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://yoriki-500811.web.app,http://localhost:8765').split(',');

// event name -> counter field on the stats doc
const EVENTS = {
  open: 'opens',
  style_selected: 'styleSelected',
  copy_open: 'copyOpen',
  decline: 'declines',
  exhausted: 'exhausted',
  // Borderline verdicts, counted separately so the dashboard can show how many
  // of these posts a human actually judged.
  borderline_fits: 'borderlineFits',
  borderline_no_fit: 'borderlineNoFit'
};

// Events we also count per distinct visitor: the first time a given
// (anonymous) device fires the event for a post, a marker document is
// created in this subcollection and the matching counter goes up. That
// turns "how many taps" into "how many people".
const UNIQUE = {
  open: { sub: 'sessions', field: 'uniqueOpens' },
  copy_open: { sub: 'copiers', field: 'uniqueCopyOpen' }
};

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if(origin && ALLOWED_ORIGINS.includes(origin)){
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
  }
  if(req.method === 'OPTIONS') return res.status(204).end();
  next();
});

async function record(req){
  const origin = req.get('Origin');
  if(origin && !ALLOWED_ORIGINS.includes(origin)) return;

  // Counters exist to be believed; letting one address inflate them makes the
  // dashboard lie about how many people the campaign actually reached.
  if(overLimit('events', clientIp(req))){
    console.warn('events rate limited');
    return;
  }

  let body = {};
  try{ body = JSON.parse(req.body || '{}'); }catch(e){ return; }

  const field = EVENTS[body.event];
  const documentId = typeof body.document_id === 'string' ? body.document_id.slice(0, 64) : '';
  const session = typeof body.session === 'string' ? body.session.slice(0, 40) : '';
  if(!field || !documentId) return;

  const statsRef = db.collection(STATS).doc(documentId);

  // Fake Hunting links carry a recipient slot, so an open can be attributed
  // to the person that link was sent to (the slot maps to a phone number in
  // fake-hunt-selections). Recorded as a per-recipient subcollection rather
  // than a counter, so the dashboard can list who acted on an alert.
  const recipient = typeof body.recipient === 'string' ? body.recipient.slice(0, 8) : '';
  if(recipient && /^\d+$/.test(recipient) && documentId.startsWith('debunk:')){
    await statsRef.collection('recipients').doc(recipient).set({
      [field]: FieldValue.increment(1),
      lastEventAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  const update = {
    [field]: FieldValue.increment(1),
    lastEventAt: FieldValue.serverTimestamp()
  };

  // Count each distinct visitor once per post, per event.
  const unique = UNIQUE[body.event];
  if(unique && session){
    try{
      await statsRef.collection(unique.sub).doc(session).create({
        at: FieldValue.serverTimestamp()
      });
      update[unique.field] = FieldValue.increment(1);
    }catch(e){ /* seen this visitor before — only the raw counter moves */ }
  }

  await statsRef.set(update, { merge: true });

  // Publishing or declining is an outcome the fake-finding server can learn
  // from too, but only for debunk alerts — the main PWA's ids are post
  // documents, not alerts, and have no request_id to key on there.
  if(outcomesConfigured() && documentId.startsWith('debunk:')
     && (body.event === 'copy_open' || body.event === 'decline')){
    const messageId = documentId.slice('debunk:'.length);
    const context = await alertContext(messageId);
    if(context.requestId){
      await pushOutcome({ requestId: context.requestId, messageId, outcome: body.event });
    }
  }
}

app.post('/e', async (req, res) => {
  // The write completes before the response: Cloud Run throttles CPU once a
  // response is sent, so work started after it can be suspended and lost.
  // The browser doesn't wait for this reply (it's a beacon), so waiting
  // costs the user nothing.
  try{
    await record(req);
  }catch(err){
    console.error('event error:', err.message);
  }
  res.status(204).end();
});

// Who reported, in a form that can be shared with the fake-hunting team
// without handing over the volunteers' phone numbers: first name plus the last
// four digits is enough to follow up internally.
async function reporterLabel(messageId, slot){
  try{
    const snap = await db.collection('fake-hunt-selections')
      .where('messageId', '==', messageId)
      .get();
    const match = snap.docs.find(d => String(d.data().variant) === String(slot));
    if(!match) return `משבצת ${slot}`;
    const phone = match.data().phone || '';
    const optin = await db.collection('fake-hunt-optins').doc('whatsapp:' + phone).get();
    const name = optin.exists ? (optin.data().firstName || '') : '';
    const tail = phone.slice(-4);
    return [name, tail && `…${tail}`].filter(Boolean).join(' ') || `משבצת ${slot}`;
  }catch(e){
    console.error('reporter lookup failed:', e.message);
    return `משבצת ${slot}`;
  }
}

// Everything the team needs to judge the report, pulled from the alert itself.
async function alertContext(messageId){
  try{
    const doc = await db.collection('fake-hunting-messages').doc(messageId).get();
    if(!doc.exists) return {};
    const data = doc.data();
    const text = String(data.text || '').replace(/https?:\/\/\S+/g, '');
    const claim = text.split(/\n\s*Debunk\s*:/i)[0].replace(/^\s*\[.*?\]\s*/, '').trim();
    return { claim, postUrl: data.post_url || '', sourceUrl: data.message_link || '',
             requestId: data.request_id || '' };
  }catch(e){
    console.error('alert lookup failed:', e.message);
    return {};
  }
}

function networkOf(url){
  const u = String(url || '').toLowerCase();
  if(/twitter\.com|\/\/x\.com/.test(u)) return 'x';
  if(u.includes('facebook.com')) return 'facebook';
  if(u.includes('instagram.com')) return 'instagram';
  if(u.includes('tiktok.com')) return 'tiktok';
  if(u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  return '';
}

app.post('/feedback', async (req, res) => {
  const origin = req.get('Origin');
  if(origin && !ALLOWED_ORIGINS.includes(origin)) return res.status(204).end();

  // Silently dropped rather than refused: a flood should not learn whether it
  // is working, and a real volunteer never reaches this ceiling.
  if(overLimit('feedback', clientIp(req))){
    console.warn('feedback rate limited');
    return res.status(204).end();
  }

  let body = {};
  try{ body = JSON.parse(req.body || '{}'); }catch(e){ return res.status(204).end(); }

  const messageId = typeof body.message_id === 'string' ? body.message_id.slice(0, 200) : '';
  if(!messageId) return res.status(204).end();

  const reasons = Array.isArray(body.reasons)
    ? body.reasons.filter(r => Object.hasOwn(REPORT_REASONS, r)).slice(0, 6)
    : [];
  const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : '';
  if(!reasons.length && !note) return res.status(204).end();

  const slot = /^\d{1,4}$/.test(String(body.recipient)) ? String(body.recipient) : '0';
  const wording = typeof body.wording === 'string' ? body.wording.slice(0, 1000) : '';

  // The write completes before the response: Cloud Run throttles CPU once a
  // response is sent, and a lost report is invisible to the person who sent it.
  try{
    const [who, context] = await Promise.all([
      reporterLabel(messageId, slot),
      alertContext(messageId),
    ]);

    await db.collection(FEEDBACK).add({
      messageId, slot, reasons, note, wording,
      gender: typeof body.gender === 'string' ? body.gender.slice(0, 10) : '',
      reportedBy: who,
      claim: context.claim || '',
      postUrl: context.postUrl || '',
      sourceUrl: context.sourceUrl || '',
      at: FieldValue.serverTimestamp(),
    });

    // Tell the fake-finding server what a human concluded, so it can mark its
    // own row true/false positive. Keyed by ITS request_id — our messageId is
    // meaningless there. Outcomes only: no phone, no name, no slot.
    if(outcomesConfigured() && context.requestId){
      for(const reason of reasons){
        await pushOutcome({
          requestId: context.requestId, messageId, outcome: reason, note,
        });
      }
    }

    if(SHEET_ID){
      // Firestore already has the report, so a sheet failure must not fail the
      // request — it is a mirror, not the record.
      try{
        await appendReport(SHEET_ID, {
          when: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }),
          messageId,
          reasons: reasons.map(r => REPORT_REASONS[r]).join(', '),
          note,
          reportedBy: who,
          claim: context.claim || '',
          wording,
          postUrl: context.postUrl || '',
          sourceUrl: context.sourceUrl || '',
          network: networkOf(context.postUrl),
          slot,
        });
      }catch(e){
        console.error('sheet append failed (report is safe in Firestore):', e.message);
      }
    } else {
      console.log('FEEDBACK_SHEET_ID is not set; report stored in Firestore only');
    }

    console.log(`problem report on ${messageId}: ${reasons.join(',') || '(note only)'}`);
  }catch(err){
    console.error('feedback error:', err.message);
  }
  res.status(204).end();
});

// Click counting for our short links (/r/<code> on the hosting site). The
// resolver page fires this as a beacon and never waits for the answer, so
// this endpoint is allowed to fail without anyone noticing — the redirect
// already happened. Counts, not identities: no IP, no user id stored.
app.post('/rc', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try{
    if(overLimit('rc', clientIp(req))) return res.status(429).json({ error: 'slow down' });
    let body = {};
    try{ body = JSON.parse(req.body || '{}'); }catch(e){}
    const code = String(body.code || '');
    // Hash-derived base64url; anything else is not one of ours.
    if(!/^[A-Za-z0-9_-]{4,16}$/.test(code)) return res.status(400).json({ error: 'bad code' });

    const ref = db.collection('short-links').doc(code);
    // update() rather than set(): a click on a code that was never created
    // must not conjure an empty document.
    await ref.update({ clicks: FieldValue.increment(1), lastClickAt: FieldValue.serverTimestamp() });
    res.json({ ok: true });
  }catch(e){
    res.status(404).json({ error: 'unknown code' });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`pwa-events listening on ${port}`));
