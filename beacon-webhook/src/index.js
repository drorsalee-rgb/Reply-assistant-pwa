// beacon-webhook — receives inbound WhatsApp messages from Beacon so people
// can join the Fake Hunting pool and choose which networks they want alerts
// for, simply by messaging the bot.
//
// This service is public by necessity (Beacon cannot present a Google ID
// token), so every request must pass HMAC verification before it is trusted.
// It is deliberately separate from signal-broadcast, which stays private.

const express = require('express');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { verifySignature, VerificationError } = require('./verify');
const { parseMessage, confirmationMessage } = require('./preferences');
const beacon = require('./beacon');

const db = new Firestore();
const app = express();

const WEBHOOK_SECRET = process.env.BEACON_WEBHOOK_SECRET || '';
const OPTINS = 'fake-hunt-optins';
const EVENTS_LOG = 'beacon-webhook-events';

// Beacon's PrivateMessageReceived payload (confirmed against a real event):
//   { id, createdAt, type, apiVersion,
//     data: { body, from: { phoneNumber, firstName, nickname, … },
//             to, chatId, timestamp, hasMedia, … } }
// `from` is an object, not a string. Fallbacks stay for other shapes.
function extractMessage(event){
  const data = event.data || event.payload || event;
  const from = data.from && typeof data.from === 'object' ? data.from : null;

  const phone =
    (from && (from.phoneNumber || from.whatsappUserId)) ||
    data.phoneNumber || data.phone ||
    (typeof data.from === 'string' ? data.from : null) ||
    (data.contact && (data.contact.phoneNumber || data.contact.phone)) || null;

  const text =
    data.body || data.text || data.content || data.messageBody ||
    (data.message && (data.message.body || data.message.text)) || '';

  const name = from ? (from.firstName || from.nickname || '') : '';

  return { phone: phone ? String(phone) : null, text: String(text || ''), name: String(name || '').trim() };
}

function normalizePhone(phone){
  const digits = String(phone).replace(/[^\d]/g, '');
  return digits ? '+' + digits : null;
}

async function recordOptIn(phone, parsed){
  const id = 'whatsapp:' + phone;
  const ref = db.collection(OPTINS).doc(id);
  const existing = await ref.get();
  const isNew = !existing.exists;

  if(parsed.action === 'stop'){
    await ref.set({
      platform: 'whatsapp', phone, active: false,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { isNew: false };
  }

  await ref.set({
    platform: 'whatsapp',
    phone,
    active: true,
    // An unrecognised message still counts as joining; no networks recorded
    // means "everything", which the confirmation explains.
    networks: parsed.networks,
    ...(isNew ? { joinedAt: FieldValue.serverTimestamp() } : {}),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { isNew };
}

// Raw body is required for signature verification.
app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if(!WEBHOOK_SECRET){
    console.error('BEACON_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'not configured' });
  }

  try{
    verifySignature(req.headers, req.body, WEBHOOK_SECRET);
  }catch(err){
    console.warn('rejected webhook:', err.message);
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event = {};
  try{
    event = JSON.parse(req.body.toString('utf8'));
  }catch(e){
    return res.status(400).json({ error: 'body is not JSON' });
  }

  // The work happens before the response: Cloud Run throttles CPU once a
  // response is sent, so anything started afterwards may never run.
  try{
    const type = event.type || event.event || '(unknown)';
    if(type !== 'PrivateMessageReceived'){
      console.log(`ignoring event type ${type}`);
      return res.status(200).json({ ok: true, ignored: type });
    }

    const { phone: rawPhone, text, name } = extractMessage(event);
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if(!phone){
      // Shape differs from what we guessed — keep it so we can adapt.
      console.error('could not find a sender in the payload; keys:', Object.keys(event));
      await db.collection(EVENTS_LOG).add({
        reason: 'no_sender', payload: req.body.toString('utf8').slice(0, 4000),
        at: FieldValue.serverTimestamp()
      });
      return res.status(200).json({ ok: true, note: 'sender not recognised' });
    }

    const parsed = parseMessage(text);
    const { isNew } = await recordOptIn(phone, parsed);
    console.log(`opt-in ${isNew ? 'created' : 'updated'}: action=${parsed.action} networks=${parsed.networks.join(',') || 'all'}`);

    const greeting = name && parsed.action !== 'stop' ? `היי ${name.split(' ')[0]}! ` : '';
    const reply = greeting + confirmationMessage(parsed, { isNew });
    await beacon.sendMessage({ phoneNumbers: [phone], message: reply });
    return res.status(200).json({ ok: true, action: parsed.action });
  }catch(err){
    console.error('failed to handle webhook event:', err.message);
    // Still acknowledge: a retry would only repeat the same failure, and the
    // person would get a second confirmation if the send half-succeeded.
    return res.status(200).json({ ok: true, error: err.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, configured: Boolean(WEBHOOK_SECRET) }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`beacon-webhook listening on ${port}`));
