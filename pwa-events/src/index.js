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

const db = new Firestore();
const app = express();
// Beacons arrive as text/plain (that avoids a CORS preflight), so accept any
// content type and parse the body ourselves.
app.use(express.text({ type: '*/*', limit: '4kb' }));

const STATS = 'pwa-stats';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://yoriki-500811.web.app,http://localhost:8765').split(',');

// event name -> counter field on the stats doc
const EVENTS = {
  open: 'opens',
  style_selected: 'styleSelected',
  copy_open: 'copyOpen',
  decline: 'declines',
  exhausted: 'exhausted'
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

app.post('/e', async (req, res) => {
  // Always answer 204 quickly: this must never slow down or break the PWA.
  res.status(204).end();
  try{
    const origin = req.get('Origin');
    if(origin && !ALLOWED_ORIGINS.includes(origin)) return;

    let body = {};
    try{ body = JSON.parse(req.body || '{}'); }catch(e){ return; }

    const field = EVENTS[body.event];
    const documentId = typeof body.document_id === 'string' ? body.document_id.slice(0, 64) : '';
    const session = typeof body.session === 'string' ? body.session.slice(0, 40) : '';
    if(!field || !documentId) return;

    const statsRef = db.collection(STATS).doc(documentId);
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
  }catch(err){
    console.error('event error:', err.message);
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`pwa-events listening on ${port}`));
