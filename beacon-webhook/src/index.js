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
const { parseMessage, confirmationMessage, invitationMessage } = require('./preferences');
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

// A number that keeps sending unrecognised text — an auto-responder, another
// bot, or a person tapping repeatedly — gets a reply every time, and if the far
// side answers automatically that is an unbounded loop between two machines.
// Observed: 8 replies in 4 minutes to one number.
//
// The opt-in is still recorded every time (cheap, idempotent). Only the outgoing
// reply is suppressed, and only when we already answered this number very
// recently. A real person changing their preferences waits far longer than this.
const REPLY_COOLDOWN_MS = Number(process.env.REPLY_COOLDOWN_MS) || 60 * 1000;
const lastReplyAt = new Map();

// The cooldown caps the damage but hides the symptom: one number sent 91
// unrecognised messages in a day and nobody knew until a volunteer complained.
// Count them per number and say so, so the system reports its own trouble.
const CHATTY = 'beacon-chatty';
const CHATTY_WINDOW_MS = 60 * 60 * 1000;
const CHATTY_THRESHOLD = Number(process.env.CHATTY_THRESHOLD) || 10;
const CHATTY_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// After this many unrecognised messages in total — not per hour — we stop
// answering the number at all. An auto-responder replies to our invitation,
// which looks like another unrecognised message, which earns another
// invitation: the per-minute cooldown slows that loop but never ends it, and
// it runs for as long as the other side keeps writing. A person who is simply
// struggling to phrase something gives up long before 25 tries.
const MUTE_AFTER = Number(process.env.CHATTY_MUTE_AFTER) || 25;
// WhatsApp, not Signal: the failure here is a chatty sender, not a broken
// connection — and a loop like this proves WhatsApp is working.
const ALERT_PHONES = (process.env.ALERT_PHONES || '+972547554469')
  .split(',').map(v => v.trim()).filter(Boolean);

/**
 * Records one unrecognised message and alerts when a single number crosses the
 * threshold. Counted in Firestore rather than memory so the tally survives
 * restarts and is shared across instances — an alert that resets on every cold
 * start would never fire.
 */
async function noteUnrecognised(phone){
  const ref = db.collection(CHATTY).doc('whatsapp:' + phone);
  const now = Date.now();
  try{
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const times = (Array.isArray(data.times) ? data.times : [])
      .filter(t => now - t < CHATTY_WINDOW_MS);
    times.push(now);

    // Counted for the lifetime of the number, unlike `times`, which is a
    // one-hour window: an auto-responder pacing itself under the hourly
    // threshold would otherwise never be muted.
    // Seeded from the existing window for numbers that were already being
    // tracked when this counter was added, so a sender mid-loop is not handed
    // a fresh 25 messages.
    const previousTotal = Number(data.totalUnrecognised)
      || (Array.isArray(data.times) ? data.times.length : 0);
    const total = previousTotal + 1;
    const wasMuted = data.muted === true;
    const muted = wasMuted || total >= MUTE_AFTER;

    const lastAlertAt = data.lastAlertAt || 0;
    const due = !muted && times.length >= CHATTY_THRESHOLD
      && now - lastAlertAt > CHATTY_ALERT_COOLDOWN_MS;

    await ref.set({
      phone,
      times: times.slice(-200),
      totalUnrecognised: total,
      ...(muted ? { muted: true } : {}),
      ...(muted && !wasMuted ? { mutedAt: FieldValue.serverTimestamp() } : {}),
      ...(due ? { lastAlertAt: now } : {}),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    // Announced once, on the message that crosses the line. After that the
    // number is silent to us and there is nothing new to report.
    if(muted && !wasMuted){
      const message = '🔇 יוריקי — הפסקנו לענות למספר\n\n'
        + `המספר ${phone} שלח ${total} הודעות שלא זוהו, ומעכשיו לא נענה לו כלל.\n\n`
        + 'סביר שזה אוטו-רספונדר: כל הזמנה ששלחנו גררה תגובה אוטומטית שנראתה '
        + 'כהודעה לא מזוהה נוספת. המספר לא רשום לקבלת התראות ואין מה להסיר — '
        + 'הוא מעולם לא נכנס למאגר.\n\n'
        + 'אם זה בן אדם, הוא עדיין יכול להירשם: הודעה עם שם רשת או "הכל" '
        + 'תיקלט כרגיל. ההשתקה חלה רק על ההזמנות.';
      for(const to of ALERT_PHONES){
        try{ await beacon.sendMessage({ phoneNumbers: [to], message }); }
        catch(e){ console.error('mute alert send failed:', e.message); }
      }
      console.warn(`muted ${phone} after ${total} unrecognised messages`);
      return { muted: true };
    }

    if(!due) return { muted };

    const message = '⚠️ יוריקי — מספר שולח הודעות לא מזוהות שוב ושוב\n\n'
      + `המספר ${phone} שלח ${times.length} הודעות שלא זוהו בשעה האחרונה `
      + `(${total} בסך הכול).\n\n`
      + 'סביר שזה אוטו-רספונדר או בוט. המספר אינו רשום לקבלת התראות — הוא לא '
      + `נכנס למאגר — ואם הוא יגיע ל-${MUTE_AFTER} הודעות נפסיק לענות לו לגמרי.`;
    for(const to of ALERT_PHONES){
      try{ await beacon.sendMessage({ phoneNumbers: [to], message }); }
      catch(e){ console.error('chatty alert send failed:', e.message); }
    }
    console.warn(`chatty-sender alert raised: ${times.length} unrecognised in the last hour`);
    return { muted };
  }catch(e){
    // Never let bookkeeping break registration.
    console.error('chatty tracking failed:', e.message);
    return { muted: false };
  }
}

function shouldReply(phone){
  const now = Date.now();
  const previous = lastReplyAt.get(phone);
  if(previous && now - previous < REPLY_COOLDOWN_MS) return false;
  lastReplyAt.set(phone, now);
  // The map is bounded by the number of people who message us in a minute;
  // prune anything older than the window so it cannot grow without limit.
  if(lastReplyAt.size > 500){
    for(const [key, at] of lastReplyAt){
      if(now - at > REPLY_COOLDOWN_MS) lastReplyAt.delete(key);
    }
  }
  return true;
}

async function recordOptIn(phone, parsed, name){
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

  // The name is the person's own WhatsApp display name, kept so the pool is
  // legible to the operator. Only stored when WhatsApp actually gave us one —
  // never overwrite a stored name with a blank.
  const firstName = String(name || '').trim().split(/\s+/)[0] || '';

  await ref.set({
    platform: 'whatsapp',
    phone,
    active: true,
    ...(firstName ? { firstName } : {}),
    // An unrecognised message still counts as joining; no networks recorded
    // means "everything", which the confirmation explains.
    networks: parsed.networks,
    // Only written when the message actually said something about it. A person
    // narrowing their networks must not silently lose (or gain) borderline
    // posts, so "not mentioned" leaves the stored value alone.
    ...(parsed.borderline === null || parsed.borderline === undefined
      ? {} : { borderline: parsed.borderline }),
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
    // A message we sent must never be treated as one we received. WhatsApp
    // encodes the fromMe flag at the head of the message id ("true_…" for our
    // own), and Beacon may surface an outbound message as a received event —
    // which turns every reply into the next request and loops with itself.
    // 818 identical replies went to one number this way before it stopped.
    // Cheap, and correct regardless of whether that was the cause.
    const data = event.data || event.payload || {};
    const messageId = String(data.id || event.id || '');
    const senderRaw = (data.from && typeof data.from === 'object')
      ? (data.from.phoneNumber || '')
      : (typeof data.from === 'string' ? data.from : '');
    const ownNumber = String(process.env.BOT_PHONE || '972524342846').replace(/\D/g, '');
    const isOurOwn = data.fromMe === true
      || messageId.startsWith('true_')
      || (!!senderRaw && String(senderRaw).replace(/\D/g, '') === ownNumber);
    if(isOurOwn){
      console.log('ignoring an echo of our own outbound message');
      return res.status(200).json({ ok: true, ignored: 'own_message' });
    }

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

    // An unrecognised message is not consent. Someone asking "what is this?"
    // used to be registered for every network and told "you're signed up",
    // and then received a fake-hunting alert she never asked for. Explain what
    // the bot does and let the next message be the actual opt-in — unless they
    // are already registered, in which case this is just chatter and their
    // existing preferences stand.
    if(parsed.action === 'unknown'){
      const { muted } = await noteUnrecognised(phone);
      const known = await db.collection(OPTINS).doc('whatsapp:' + phone).get();
      if(!known.exists){
        // Muting applies to the invitation only. A muted number that finally
        // writes something we understand — a network name, "הכל" — never
        // reaches here, because parsed.action would not be 'unknown', and it
        // registers normally. We stop talking to a machine; we do not lock a
        // person out.
        if(muted){
          console.log('unrecognised message from a muted number: no reply');
          return res.status(200).json({ ok: true, action: 'muted' });
        }
        if(!shouldReply(phone)){
          console.warn('invitation suppressed by the loop guard');
          return res.status(200).json({ ok: true, action: 'invited', reply: 'suppressed' });
        }
        const greeting = name ? `היי ${name.split(' ')[0]}! ` : '';
        await beacon.sendMessage({
          phoneNumbers: [phone],
          message: greeting ? greeting + invitationMessage().replace(/^היי! /, '') : invitationMessage()
        });
        console.log('unrecognised message from an unknown number: invited, not registered');
        return res.status(200).json({ ok: true, action: 'invited' });
      }
    }

    const { isNew } = await recordOptIn(phone, parsed, name);
    console.log(`opt-in ${isNew ? 'created' : 'updated'}: action=${parsed.action} networks=${parsed.networks.join(',') || 'all'}`);

    if(!shouldReply(phone)){
      console.warn(`reply suppressed: already answered this number within ${REPLY_COOLDOWN_MS}ms (loop guard)`);
      return res.status(200).json({ ok: true, action: parsed.action, reply: 'suppressed' });
    }

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
