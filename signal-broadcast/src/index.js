// signal-broadcast — receives a broadcast trigger and sends Signal messages
// containing a reply-assistant PWA link.
//
// Two flows, selected by the channel's type in Firestore:
//   "group"     — one message to a mapped Signal group (everyone sees it)
//   "fake-hunt" — weighted-random selection of N opted-in users, each gets a
//                 1:1 DM linking to the debunk PWA (selection is invisible
//                 to the rest of the pool)
//
// Runs in the torino-social GCP project alongside the reactions engine, so
// Firestore access is same-project. Signal sends go through a
// signal-cli-rest-api instance (SIGNAL_API_URL).

const express = require('express');
const crypto = require('crypto');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const LOGOS = require('./logos');
const beacon = require('./beacon');
const { generateVariants } = require('./variants');
const { checkPostClaims } = require('./grounding');
const { summarisePost } = require('./postSummary');
const notify = require('./notify');
const { DEFAULT_NETWORKS } = require('./preferences');

const db = new Firestore();
const app = express();
app.use(express.json());

// ---- config ----
const SIGNAL_API_URL = process.env.SIGNAL_API_URL || '';   // e.g. http://10.x.x.x:8080
const SIGNAL_NUMBER = process.env.SIGNAL_NUMBER || '+972559761823';
const PWA_BASE_URL = process.env.PWA_BASE_URL || 'https://yoriki-500811.web.app';
// The debunk PWA: shows the claim and a single ready-made rebuttal, with no
// style picker and no alternative suggestions.
const DEBUNK_PWA_URL = process.env.DEBUNK_PWA_URL || (PWA_BASE_URL + '/debunk');
const DEFAULT_FAN_OUT_CAP = 4;
// How strongly to deprioritize recently-selected users: weight = 1 / (1 + picks_in_window)^2
const SELECTION_WINDOW_DAYS = 30;

// Firestore collections
// content_providers is the EXISTING table (owned by the engine/Slack side):
//   doc id = provider_id, fields: channel_id (Slack), channel_name,
//   provider_name, provider_desc. This service additionally expects:
//   signal_group_id (string) for group providers, and
//   broadcast_type: "fake-hunt" (+ optional fan_out_cap) for the debunk flow.
const PROVIDERS = 'content_providers';
const ALERTS = 'broadcast-alerts';            // {key} -> { at, text } — alert cooldown

// Misconfiguration alerts go to a person and to the ops group, so a broken
// routing table is noticed immediately rather than at the next broadcast.
const ALERT_PHONES = (process.env.ALERT_PHONES || '+972547554469')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALERT_GROUP_ID = process.env.ALERT_GROUP_ID
  || 'W0LqlByy5xcLrAEeSjx9CI6c9HhwKRD1szTsWhuvwVI=';   // Yoriki Integration Test
const ALERT_COOLDOWN_HOURS = 6;
const OPTINS = 'fake-hunt-optins';            // {phone} -> { joinedAt, active }
const SELECTIONS = 'fake-hunt-selections';    // log: { phone, documentId, selectedAt }
const BROADCASTS = 'broadcast-log';           // audit log of every /api/broadcast call

function requestId(){ return crypto.randomUUID(); }

// ---- signal-cli-rest-api client ----
// Attaching the logo as an image is optional: the message also names the
// network in text with a symbol, which is lighter and keeps the Signal
// message a plain text message. Flip with ATTACH_LOGO=true.
const ATTACH_LOGO = process.env.ATTACH_LOGO === 'true';

// Maps the doc's socialMedia value to the logo attached to the message.
function logoFor(socialMedia){
  if(!ATTACH_LOGO) return null;
  const key = (socialMedia || '').toLowerCase();
  const name = key === 'twitter' ? 'x' : key;
  return LOGOS[name] || null;
}

async function signalSend({ recipients, groupId, message, logo }){
  if(!SIGNAL_API_URL){
    console.log('[stub] SIGNAL_API_URL not set; would send:', JSON.stringify({ recipients, groupId, message, logo: !!logo }));
    return { stubbed: true };
  }
  const body = { number: SIGNAL_NUMBER, message, text_mode: 'styled' };
  if(logo) body.base64_attachments = [`data:image/png;filename=network.png;base64,${logo}`];
  // signal-cli-rest-api addresses groups as "group." + base64(internal group
  // id); we store the internal id (what signal-cli listGroups prints).
  if(groupId) body.recipients = ['group.' + Buffer.from(groupId).toString('base64')];
  else body.recipients = recipients;
  const res = await fetch(SIGNAL_API_URL + '/v2/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const text = await res.text();
    throw new Error(`signal-cli send failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---- message templates ----
// The network name is included so members who aren't active on that network
// know to skip the link.
const NETWORK_HE = {
  twitter: 'X', x: 'X', facebook: 'פייסבוק', instagram: 'אינסטגרם',
  tiktok: 'טיקטוק', youtube: 'יוטיוב', linkedin: 'לינקדאין'
};

// Unicode has no brand logos, so these are the closest widely-rendered
// stand-ins. 𝕏 is a real character, the rest are thematic.
const NETWORK_SYMBOL = {
  twitter: '𝕏', x: '𝕏', facebook: '📘', instagram: '📸',
  tiktok: '🎵', youtube: '▶️', linkedin: '💼'
};

// Signal renders **bold** when the message is sent with text_mode "styled",
// which makes the network stand out at a glance — the symbols alone are
// easy to miss, especially in dark mode.
function networkLine(socialMedia){
  const key = (socialMedia || '').toLowerCase();
  const name = NETWORK_HE[key];
  if(!name) return '';
  const symbol = NETWORK_SYMBOL[key] || '🌐';
  return `${symbol} הפוסט ברשת **${name}** — אם אינך פעיל/ה שם, אפשר לדלג.\n\n`;
}

// Signal marks bold with **double** asterisks, WhatsApp with *single* ones;
// sending Signal's syntax to WhatsApp shows the asterisks as literal text.
function forWhatsApp(message){
  return message.replace(/\*\*(.+?)\*\*/g, '*$1*');
}

// The network line is skipped for a group dedicated to a single network —
// everyone there is already following exactly that one.
function groupMessage(snippet, link, socialMedia, { withNetworkLine = true } = {}){
  const network = withNetworkLine ? networkLine(socialMedia) : '';
  return `היי! יש פוסט חדש שכדאי להגיב עליו 👇\n\n${snippet}\n\n${network}לחצו כאן להצעת תגובה:\n${link}`;
}

// A target restricted to exactly one network doesn't need the line; one that
// covers several (or everything) still tells the reader which it is.
function needsNetworkLine(target){
  return target.include.length !== 1;
}

function debunkMessage(snippet, link, socialMedia){
  return `היי! זיהינו פייק שכדאי להפריך 👇\n\n${snippet}\n\n${networkLine(socialMedia)}לחצו כאן להודעת הפרכה מוכנה:\n${link}`;
}

function truncate(text, max = 200){
  if(!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

// The generator writes summaries with markdown, and sometimes in English.
// Recipients should get clean Hebrew in the Signal message itself, not just
// inside the PWA.
// The engine's post_text repeats the post after a "Description:" label, so
// the 200-character message ends up showing the same sentence twice. Keep
// the first copy when the two clearly overlap.
function stripDuplicateDescription(text){
  const match = String(text || '').match(/^([\s\S]+?)\n\s*Description:\s*([\s\S]+)$/i);
  if(!match) return text;
  const head = match[1].trim();
  const tail = match[2].trim();
  if(!head || !tail) return text;
  const overlap = 30;
  const same = head.slice(0, overlap) === tail.slice(0, overlap);
  return same ? head : text;
}

function cleanSnippet(text){
  return stripDuplicateDescription(String(text || ''))
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    // Links inside the quoted post (t.co shorteners and the like) compete
    // with our own link — the reader can't tell which one to tap.
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isMostlyEnglish(text){
  const hebrew = (text.match(/[֐-׿]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return latin > 0 && hebrew / (hebrew + latin) < 0.34;
}

async function translateToHebrew(text){
  try{
    const source = text.slice(0, 1500);   // keep the request URL sane
    const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=he&dt=t&q='
      + encodeURIComponent(source));
    if(!res.ok) return null;
    const data = await res.json();
    const out = (data[0] || []).map(seg => seg[0]).filter(Boolean).join('');
    return out || null;
  }catch(e){
    return null;
  }
}

// Clean, translate if needed, then trim to message length.
async function prepareSnippet(text, rid){
  let snippet = cleanSnippet(text);
  if(snippet && isMostlyEnglish(snippet)){
    const translated = await translateToHebrew(snippet);
    if(translated) snippet = cleanSnippet(translated);
    else console.log(rid, 'translation failed; sending the original summary');
  }
  return truncate(snippet);
}

// ---- routing targets ----
// A provider can fan out to several Signal groups, each optionally filtered
// by the post's network:
//   signal_targets: [
//     { group_id: "…" },                                   // everything
//     { group_id: "…", networks: ["facebook","instagram"] } // only these
//     { group_id: "…", exclude_networks: ["facebook"] }     // all but these
//   ]
// A plain signal_group_id still works and means "one target, everything".
function normalizeNetwork(name){
  const key = String(name || '').toLowerCase();
  return key === 'twitter' ? 'x' : key;
}

function toTargets(list, fallbackId){
  const targets = Array.isArray(list) ? list : null;
  if(targets && targets.length){
    return targets
      .filter(t => t && t.group_id)
      .map(t => ({
        groupId: t.group_id,
        include: (t.networks || []).map(normalizeNetwork),
        exclude: (t.exclude_networks || []).map(normalizeNetwork)
      }));
  }
  return fallbackId ? [{ groupId: fallbackId, include: [], exclude: [] }] : [];
}

function targetsFor(channel){
  return toTargets(channel.signal_targets, channel.signal_group_id);
}

// WhatsApp delivery through Beacon, configured exactly like the Signal
// targets: whatsapp_targets[] with optional per-network filters, or a plain
// whatsapp_group_id for a single destination.
function whatsappTargetsFor(channel){
  return toTargets(channel.whatsapp_targets, channel.whatsapp_group_id);
}

function targetAccepts(target, socialMedia){
  const network = normalizeNetwork(socialMedia);
  if(target.exclude.length && target.exclude.includes(network)) return false;
  if(target.include.length && !target.include.includes(network)) return false;
  return true;
}

// ---- routing-table health checks ----
async function listGroups(){
  if(!SIGNAL_API_URL) return [];
  const res = await fetch(SIGNAL_API_URL + '/v1/groups/' + encodeURIComponent(SIGNAL_NUMBER));
  if(!res.ok) throw new Error(`listing groups failed (${res.status})`);
  return res.json();
}

// One Signal message per problem per cooldown window, so a misconfiguration
// left in place doesn't turn into a stream of identical alerts.
async function sendAlert(key, text, rid, options = {}){
  const docId = key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  const ref = db.collection(ALERTS).doc(docId);
  const snap = await ref.get();
  const last = snap.exists && snap.data().at ? snap.data().at.toDate() : null;
  if(last && Date.now() - last.getTime() < ALERT_COOLDOWN_HOURS * 3600 * 1000) return;
  await ref.set({ at: FieldValue.serverTimestamp(), text, requestId: rid });

  const title = options.title || 'תקלה בהגדרות השידור';
  const footer = options.footer === undefined
    ? '\n\n(השידור עצמו בוצע; יש לתקן את טבלת הערוצים.)'
    : (options.footer ? '\n\n' + options.footer : '');
  const message = `⚠️ יוריקי — ${title}\n\n${text}${footer}`;
  try{
    if(ALERT_PHONES.length) await signalSend({ recipients: ALERT_PHONES, message });
    if(ALERT_GROUP_ID) await signalSend({ groupId: ALERT_GROUP_ID, message });
  }catch(e){
    console.error(rid, 'alert send failed:', e.message);
  }
}

// Returns a human-readable problem description, or null when the provider's
// Signal routing is sound.
async function checkGroupRouting(channel, targets){
  // Channels can be merged into one group on purpose (shared_group_ok);
  // only an accidental overlap is worth an alert.
  if(!channel.shared_group_ok){
    const ids = targets.map(t => t.groupId);
    const sharing = await db.collection(PROVIDERS)
      .where('signal_group_id', 'in', ids.slice(0, 10)).get();
    const others = sharing.docs
      .filter(d => d.id !== channel.id && !d.data().shared_group_ok)
      .map(d => d.id);
    if(others.length){
      return `הספק "${channel.id}" מקושר לאותה קבוצת סיגנל כמו: ${others.join(', ')}. `
           + `כתוצאה מכך תוכן של ערוץ אחד נשלח לקהל של ערוץ אחר.`;
    }
  }

  // A group the bot was removed from (or that was deleted) would otherwise
  // fail deep inside signal-cli with an opaque error.
  const groups = await listGroups();
  if(groups.length){
    const missing = targets
      .map(t => t.groupId)
      .filter(id => !groups.some(g => g.internal_id === id));
    if(missing.length){
      return `הבוט אינו חבר ב-${missing.length} מקבוצות הסיגנל המוגדרות לספק "${channel.id}" `
           + `(ייתכן שקבוצה נמחקה או שהבוט הוסר ממנה).`;
    }
  }
  return null;
}

// ---- the opt-in pool ----
// Primary source: the members of the provider's Signal group (the "silent
// group" pattern — joining the group IS opting in). Falls back to the
// fake-hunt-optins collection when the provider has no group. The bot's own
// number is excluded.
function digitsOf(value){
  return String(value || '').replace(/\D/g, '');
}

// Fake Hunting alerts go out over WhatsApp only: the pool is the people who
// opted in by messaging the bot. Signal group membership is not a form of
// consent — it carries no network preference and no explicit registration —
// so those members are not drawn.
//
// `network` filters to people who asked for alerts on that network.
async function fetchPool(network){
  const pool = [];

  const wanted = normalizeNetwork(network);
  const optinsSnap = await db.collection(OPTINS).where('active', '==', true).get();
  for(const doc of optinsSnap.docs){
    const data = doc.data();
    // No preference recorded means the default set — someone who joined
    // without naming networks is not signed up for YouTube or LinkedIn.
    const prefs = Array.isArray(data.networks) && data.networks.length
      ? data.networks : DEFAULT_NETWORKS;
    const wantsIt = !wanted || prefs.map(normalizeNetwork).includes(wanted);
    if(!wantsIt) continue;
    pool.push({ phone: data.phone || doc.id, platform: 'whatsapp' });
  }

  // One entry per person, even if the same number was registered twice under
  // differently formatted ids.
  const byPerson = new Map();
  for(const entry of pool){
    byPerson.set(digitsOf(entry.phone) || entry.phone, entry);
  }
  return [...byPerson.values()];
}

// Two alerts about the same claim (the same lie posted by different accounts)
// look like a duplicate to whoever receives both. Key them by the claim text
// so the rotation can hand them to different people.
const CLAIM_WINDOW_HOURS = 24;

function claimKeyOf(claim){
  const normalized = String(claim || '')
    .replace(/["'\u201c\u201d\u2018\u2019]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 160);
  if(!normalized) return null;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

// ---- fair-rotation selection from the pool ----
// Weighted random was too lumpy on a small pool: with 8 people and 4 slots,
// one person can draw every alert in a burst (measured at ~1% for six in a
// row, which is often enough to be noticed and resented).
//
// Instead, rank by how recently and how often someone was messaged and take
// the quietest. Randomness only breaks ties, so nobody gets two alerts while
// somebody else waits.
const RECENT_LOAD_HOURS = 24;

async function selectRecipients(cap, network, claimKey = null){
  const pool = await fetchPool(network);
  if(pool.length === 0) return [];

  const windowStart = new Date(Date.now() - SELECTION_WINDOW_DAYS * 24 * 3600 * 1000);
  const recentSnap = await db.collection(SELECTIONS)
    .where('selectedAt', '>=', windowStart).get();

  const loadCutoff = Date.now() - RECENT_LOAD_HOURS * 3600 * 1000;
  const claimCutoff = Date.now() - CLAIM_WINDOW_HOURS * 3600 * 1000;
  const stats = {};
  recentSnap.forEach(d => {
    const data = d.data();
    const phone = data.phone;
    if(!phone) return;
    const at = data.selectedAt && data.selectedAt.toDate ? data.selectedAt.toDate().getTime() : 0;
    const entry = stats[phone] || (stats[phone] = { recent: 0, total: 0, last: 0, sawClaim: 0 });
    entry.total += 1;
    if(at >= loadCutoff) entry.recent += 1;
    if(at > entry.last) entry.last = at;
    if(claimKey && data.claimKey === claimKey && at >= claimCutoff) entry.sawClaim = 1;
  });

  const ranked = pool.map(u => {
    const st = stats[u.phone] || { recent: 0, total: 0, last: 0, sawClaim: 0 };
    return { ...u, recent: st.recent, total: st.total, last: st.last,
             sawClaim: st.sawClaim, jitter: Math.random() };
  }).sort((a, b) =>
    a.sawClaim - b.sawClaim || // never sent this same claim before
    a.recent - b.recent ||     // fewest alerts in the last day
    a.last - b.last ||         // longest since we last bothered them
    a.total - b.total ||       // fewest all time
    a.jitter - b.jitter);      // random among equals

  if(claimKey){
    const repeats = ranked.slice(0, Math.min(cap, pool.length)).filter(u => u.sawClaim).length;
    if(repeats) console.log(`pool too small: ${repeats} recipient(s) get this claim twice`);
  }

  return ranked.slice(0, Math.min(cap, pool.length))
    .map(u => ({ phone: u.phone, platform: u.platform }));
}

// ---- reaction-pool readiness ----
// A broadcast link is useless if the document's reaction pools are empty:
// users whose style maps to an empty pool just see "no suggestions". Pool
// generation can lag document creation by a few seconds, so wait briefly
// and re-check rather than immediately sending a dead link to a group.
const POOL_WAIT_MS = Number(process.env.POOL_WAIT_MS || 45000);
const POOL_POLL_MS = Number(process.env.POOL_POLL_MS || 3000);

function poolStatus(postData){
  const reactions = (postData && postData.reactions) || {};
  const styles = Object.keys(reactions);
  const empty = styles.filter(s => {
    const available = reactions[s] && reactions[s].availableReactions;
    return !Array.isArray(available) || available.length === 0;
  });
  return { styles: styles.length, empty };
}

async function waitForPools(document_id, rid){
  const deadline = Date.now() + POOL_WAIT_MS;
  for(;;){
    const doc = await db.collection('social-reactions').doc(document_id).get();
    if(!doc.exists) return { ok: false, missing: true, data: {} };
    const data = doc.data();
    const status = poolStatus(data);
    if(status.styles > 0 && status.empty.length === 0) return { ok: true, data };
    if(Date.now() >= deadline) return { ok: false, data, status };
    console.log(rid, `pools not ready (${status.empty.length}/${status.styles} styles empty), waiting…`);
    await new Promise(r => setTimeout(r, POOL_POLL_MS));
  }
}

// ---- provider lookup ----
// Accepts either the provider_id (content_providers doc id) or the Slack
// channel_id stored on the provider doc — so callers can pass whichever
// identifier they have.
async function findProvider({ provider_id, channel_id }){
  if(provider_id){
    const doc = await db.collection(PROVIDERS).doc(provider_id).get();
    if(doc.exists) return { id: doc.id, ...doc.data() };
  }
  if(channel_id){
    const snap = await db.collection(PROVIDERS).where('channel_id', '==', channel_id).limit(1).get();
    if(!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  return null;
}

// ---- the endpoint ----
// POST /api/broadcast
// {
//   "document_id": "...",   // required — social-reactions doc created by the engine
//   "provider_id": "...",   // one of provider_id / channel_id required —
//   "channel_id":  "...",   //   identifies the content provider
//   "post_text":   "...",   // optional — snippet for the Signal message;
//                           //   falls back to the doc's postDescription
// }
app.post('/api/broadcast', async (req, res) => {
  const rid = requestId();
  console.log(rid, 'broadcast request:', JSON.stringify(req.body));
  const respond = (status, payload) => {
    console.log(rid, 'broadcast response:', status, JSON.stringify(payload));
    return res.status(status).json({ ...payload, requestId: rid });
  };
  try{
    const { document_id, provider_id, channel_id, post_text, skip_pool_check, only } = req.body || {};
    // `only` limits delivery to one platform. Used to resend messages that a
    // broken WhatsApp session swallowed, without double-posting to Signal.
    if(only && !['signal', 'whatsapp'].includes(only)){
      return respond(400, { error: "only must be 'signal' or 'whatsapp'" });
    }
    if(!document_id || (!provider_id && !channel_id)){
      return respond(400, { error: 'document_id and provider_id (or channel_id) are required' });
    }

    const channel = await findProvider({ provider_id, channel_id });
    if(!channel){
      return respond(404, { error: `Unknown provider: ${provider_id || channel_id}` });
    }

    // Refuse to broadcast a link whose reaction pools aren't populated yet;
    // the post doc also supplies the network name and (when the payload
    // doesn't carry one) the snippet.
    let postData;
    if(skip_pool_check){
      const doc = await db.collection('social-reactions').doc(document_id).get();
      postData = doc.exists ? doc.data() : {};
    } else {
      const check = await waitForPools(document_id, rid);
      if(!check.ok){
        if(check.missing){
          return respond(404, { error: `Document not found: ${document_id}` });
        }
        return respond(409, {
          error: `Reaction pools not ready for ${document_id}: ${check.status.empty.length} of ${check.status.styles} styles are empty. Nothing sent — retry once generation completes (or pass skip_pool_check to override).`,
          empty_styles: check.status.empty
        });
      }
      postData = check.data;
    }
    const socialMedia = postData.socialMedia;
    const snippet = await prepareSnippet(post_text || postData.postDescription, rid);

    let result;
    if(channel.broadcast_type === 'fake-hunt'){
      const cap = channel.fan_out_cap || DEFAULT_FAN_OUT_CAP;
      const link = `${DEBUNK_PWA_URL}/?document_id=${encodeURIComponent(document_id)}`;
      const recipients = await selectRecipients(cap, networkFromUrl(postData.postUrl));
      if(recipients.length === 0){
        return respond(409, { error: 'No active opted-in users in the pool' });
      }
      const message = debunkMessage(snippet, link, socialMedia);
      for(const { phone } of recipients){
        await beacon.sendMessage({ phoneNumbers: [phone], message: forWhatsApp(message) });
        await db.collection(SELECTIONS).add({
          phone, platform: 'whatsapp', documentId: document_id,
          selectedAt: FieldValue.serverTimestamp()
        });
      }
      result = { flow: 'fake-hunt', recipients: recipients.length };
    } else {
      const targets = targetsFor(channel);
      // A provider may legitimately live on one platform only — a WhatsApp-only
      // group, for instance. Refuse when there is no destination at all, or when
      // the platform this request asked for has none; a missing Signal group is
      // not an error for a WhatsApp-only send.
      const waConfigured = whatsappTargetsFor(channel).length > 0;
      const noDestination = !targets.length && !waConfigured;
      const askedForMissingSignal = only === 'signal' && !targets.length;
      const askedForMissingWhatsapp = only === 'whatsapp' && !waConfigured;
      if(noDestination || askedForMissingSignal || askedForMissingWhatsapp){
        const missing = askedForMissingWhatsapp ? 'WhatsApp' : (askedForMissingSignal ? 'Signal' : 'Signal or WhatsApp');
        return respond(409, { error: `Provider ${channel.id} has no ${missing} target — add the bot to the group and store the group id on the content_providers doc` });
      }
      // A routing problem raises an alert but does not stop the broadcast —
      // a delivered message is better than a silently skipped one, and the
      // alert tells us to fix the table.
      let warning = null;
      try{
        warning = await checkGroupRouting(channel, targets);
        if(warning) await sendAlert(`routing:${channel.id}`, warning, rid);
      }catch(e){
        console.error(rid, 'routing check failed:', e.message);
      }

      const link = `${PWA_BASE_URL}/?document_id=${encodeURIComponent(document_id)}`;
      const messageFor = target => groupMessage(snippet, link, socialMedia,
        { withNetworkLine: needsNetworkLine(target) });

      const matching = (only === 'whatsapp' ? [] : targets).filter(t => targetAccepts(t, socialMedia));
      for(const target of matching){
        await signalSend({ groupId: target.groupId, message: messageFor(target), logo: logoFor(socialMedia) });
      }
      const sentTo = matching.map(t => t.groupId);

      // WhatsApp goes out through Beacon, filtered by the same network rules.
      // A WhatsApp failure must not fail the whole broadcast: Signal has
      // already been delivered by this point.
      const waTargets = (only === 'signal' ? [] : whatsappTargetsFor(channel))
        .filter(t => targetAccepts(t, socialMedia));
      let whatsappGroupIds = [];
      let whatsappError = null;
      if(waTargets.length && beacon.isConfigured()){
        try{
          // Groups dedicated to one network get a message without the
          // network line, so they can't share a single send.
          for(const target of waTargets){
            await beacon.sendMessage({
              groupIds: [target.groupId],
              message: forWhatsApp(messageFor(target))
            });
            whatsappGroupIds.push(target.groupId);
          }
        }catch(e){
          whatsappError = e.message;
          console.error(rid, 'WhatsApp send failed:', e.message);
          await sendAlert(`whatsapp:${channel.id}`,
            `שליחת ההודעה לוואטסאפ נכשלה עבור הספק "${channel.id}": ${e.message}`, rid);
        }
      } else if(waTargets.length && !beacon.isConfigured()){
        console.log(rid, 'WhatsApp targets configured but Beacon credentials are missing');
      }

      result = {
        flow: 'group',
        signalGroupId: sentTo[0] || null,      // kept for existing consumers
        signalGroupIds: sentTo,
        whatsappGroupIds,
        skippedByFilter: targets.length - matching.length
      };
      if(whatsappError) result.whatsappError = whatsappError;
      if(!sentTo.length){
        console.log(rid, `no target accepts network "${socialMedia}" for provider ${channel.id}`);
      }
      if(warning) result.warning = warning;
    }

    await db.collection(BROADCASTS).add({
      documentId: document_id, providerId: channel.id, ...result,
      at: FieldValue.serverTimestamp(), requestId: rid
    });
    respond(200, { ok: true, ...result });
  }catch(err){
    console.error(rid, err);
    respond(500, { error: 'Internal error' });
  }
});

// ---- Fake Hunting: personal Signal messages to N drawn individuals ----
//
// Called by the fake-hunting-orchestrator after each alert. Unlike the group
// flow, this messages people one by one so the selection stays invisible to
// everyone else.
//
// The recipient pool is the membership of a designated Signal group (people
// opt in by joining it), configured in Firestore at
// broadcast-config/fake-hunting.signal_group_id, or via FAKE_HUNT_GROUP_ID.
// With neither, it falls back to the fake-hunt-optins collection.
const CONFIG = 'broadcast-config';
const FAKE_HUNT_MESSAGES = 'fake-hunt-messages';   // {message_id} -> dedupe record
const FAKE_HUNTING_ALERTS = 'fake-hunting-messages'; // written by the orchestrator
const MAX_FAKE_HUNT_N = 100;
// How many people each Fake Hunting alert goes to. The orchestrator sends its
// own N, but the fan-out is our call, not theirs — it depends on the size of
// our pool and how often we're willing to message the same person. Set
// FAKE_HUNT_N to change it without touching the orchestrator.
const FAKE_HUNT_N = Number(process.env.FAKE_HUNT_N) || 4;

// The orchestrator sends a link to the content. When that link points at a
// social network, it already tells us which one — no extra field needed.
// A link to our own or a third-party site yields null, and no filtering.
function networkFromUrl(url){
  let host;
  try{ host = new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); }
  catch(e){ return null; }

  if(/(^|\.)(x|twitter)\.com$/.test(host) || host === 't.co') return 'x';
  if(/(^|\.)(facebook\.com|fb\.com|fb\.watch|m\.facebook\.com)$/.test(host)) return 'facebook';
  if(/(^|\.)instagram\.com$/.test(host)) return 'instagram';
  if(/(^|\.)(tiktok\.com|vt\.tiktok\.com)$/.test(host)) return 'tiktok';
  if(/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube';
  if(/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
  return null;
}

// Generated once per alert and stored for the debunk PWA to read. Kept in our
// own collection so the orchestrator's documents stay untouched.
const DEBUNK_VARIANTS = 'debunk-variants';

// Each recipient gets their own private block of wordings, so browsing
// alternatives can never land on the text handed to someone else.
const WORDINGS_PER_PERSON = 3;

// Words the rewrites took from the claim because the debunk itself never
// named who acted. Hebrew has no capitalisation to key on, so this simply
// reports the distinctive words that crossed over.
function inferredAttribution(debunk, claim, variants){
  if(!claim) return [];
  const inDebunk = new Set(String(debunk).split(/[^\p{L}\p{N}"']+/u));
  const fromClaim = String(claim).split(/[^\p{L}\p{N}"']+/u)
    .filter(w => w.length >= 4 && !inDebunk.has(w));
  const crossed = fromClaim.filter(w => variants.some(v => v.includes(w)));
  return [...new Set(crossed)];
}

// Returns how many recipients can be served. Each wants WORDINGS_PER_PERSON
// wordings of their own, but when generation yields fewer, the block shrinks
// rather than letting two people share one — one wording each still beats
// everyone posting the same sentence.
function planBlocks(total, people){
  if(!total) return { perPerson: 0, servable: 0 };
  const perPerson = Math.max(1, Math.min(WORDINGS_PER_PERSON, Math.floor(total / people)));
  return { perPerson, servable: Math.min(people, Math.floor(total / perPerson)) };
}

async function variantsFor(messageId, debunk, people, maxChars, claim, postUrl, postText, provided){
  const wanted = people * WORDINGS_PER_PERSON;
  const ref = db.collection(DEBUNK_VARIANTS).doc(String(messageId).slice(0, 200));
  const existing = await ref.get();
  if(existing.exists){
    const data = existing.data();
    const stored = Array.isArray(data.male) && data.male.length
      ? data.male
      // Documents written before gendered variants existed.
      : (Array.isArray(data.variants) ? data.variants : []);
    if(stored.length >= people){
      const plan = planBlocks(stored.length, people);
      if((data.perPerson || 1) === plan.perPerson) return plan.servable;
    }
  }

  // What the PWA shows above the suggested reply. The engine's `claim` is an
  // abstract proposition and often has no subject, so it is the fallback here
  // rather than the first choice. Generated once per alert, not per recipient.
  const postSummary = await summarisePost(cleanSnippet(postText), claim);

  // Wordings supplied by the fake-finding server take precedence over local
  // generation: they were written against the full post text, the verified
  // evidence items, and a web search — all of which it has and we don't. Our
  // own generation (below) stays as the fallback when no variants arrive.
  if(provided && Array.isArray(provided.male) && provided.male.length){
    const seen = new Set();
    const male = [];
    const female = [];
    provided.male.forEach((m, i) => {
      const text = String(m || '').trim();
      const f = String((provided.female || [])[i] || text).trim();
      const key = text.replace(/\s+/g, ' ');
      if(!text || seen.has(key)) return;
      // The one contract we still enforce locally: an unpostable wording must
      // not go out, whatever generated it.
      if(maxChars && (text.length > maxChars || f.length > maxChars)) return;
      seen.add(key);
      male.push(text);
      female.push(f);
    });
    // The upstream count is a constant on their side; ours is people ×
    // WORDINGS_PER_PERSON here. They cannot know our number — they generate
    // before contacting us — so the two drift silently. Rather than coordinate,
    // top up locally when what arrived is short: dropping recipients because
    // an unrelated service was configured with a smaller number is the one
    // outcome worth avoiding.
    if(male.length && male.length < people * WORDINGS_PER_PERSON){
      const shortfall = people * WORDINGS_PER_PERSON - male.length;
      console.log(`upstream sent ${male.length} of ${people * WORDINGS_PER_PERSON} wordings; generating ${shortfall} more locally`);
      try{
        const extra = await generateVariants(debunk, shortfall, { maxChars, claim, postText });
        extra.male.forEach((m, i) => {
          const key = String(m || '').trim().replace(/\s+/g, ' ');
          if(!key || seen.has(key)) return;
          seen.add(key);
          male.push(m.trim());
          female.push((extra.female[i] || m).trim());
        });
      }catch(e){
        // Fewer wordings than ideal still serves everyone as long as there is
        // at least one each; only a hard failure would cost a recipient.
        console.error('top-up generation failed, using the upstream wordings alone:', e.message);
      }
    }

    if(male.length){
      const plan = planBlocks(male.length, people);
      await ref.set({
        male, female,
        perPerson: plan.perPerson,
        variants: male,
        original: debunk,
        source: 'upstream',        // generated by the fake-finding server
        postUrl: postUrl || null,
        postText: postText || null,
        postSummary: postSummary || null,
        createdAt: FieldValue.serverTimestamp()
      });
      console.log(`upstream wordings: ${male.length} usable -> ${plan.perPerson} each for ${plan.servable} recipients`);
      return plan.servable;
    }
    console.log('upstream wordings arrived but none fit the limit; generating locally');
  }

  // Check what the post adds on top of the known claim, against live sources.
  // Never fatal: a failed check means the wordings answer the claim alone,
  // exactly as they did before grounding existed.
  let findings = [];
  let sources = [];
  if(postText){
    try{
      const checked = await checkPostClaims(claim, debunk, postText);
      findings = checked.findings;
      sources = checked.sources;
      console.log(`grounded check: ${findings.length} contradiction(s) from ${sources.length} source(s)`);
    }catch(e){
      console.error('grounded check failed, continuing without it:', e.message);
    }
  }

  const { male, female, subjectUnclear, tooLong } = await generateVariants(debunk, wanted, { maxChars, claim, postText, findings });
  // The debunk never says who acted, and the claim doesn't settle it either.
  // Publishing it under someone's name risks blaming the wrong person.
  if(subjectUnclear) return -1;
  // Nothing fits the network's limit, not even after a shortening attempt.
  // Sending it would hand volunteers a reply the network rejects outright.
  if(tooLong) return -2;
  if(!male.length) return 0;

  // A name the debunk never mentioned came from the claim — a judgement call
  // by the model, not something the team wrote. Record it so a wrong
  // attribution can be traced back rather than silently published.
  const inferred = inferredAttribution(debunk, claim, male);
  if(inferred.length){
    console.log(`attribution inferred from the claim: ${inferred.join(', ')}`);
  }
  const plan = planBlocks(male.length, people);
  await ref.set({
    male, female,
    perPerson: plan.perPerson,
    variants: male,          // kept for anything reading the older shape
    original: debunk,
    inferredAttribution: inferred,
    // Copied here so the published reply can open the offending post even if
    // the orchestrator's own document is missing or changes shape.
    postUrl: postUrl || null,
    // Recorded so a complaint about a wording can be judged against what the
    // model was actually shown.
    postText: postText || null,
    postSummary: postSummary || null,
    // Kept so a disputed wording can be traced to the fact and the page it
    // came from, rather than argued about from memory.
    groundedFindings: findings,
    groundedSources: sources,
    createdAt: FieldValue.serverTimestamp()
  });
  console.log(`${male.length} wordings -> ${plan.perPerson} each for ${plan.servable} recipients`);
  return plan.servable;
}

app.post('/api/broadcast-fake-hunting', async (req, res) => {
  const rid = requestId();
  const body = req.body || {};
  console.log(rid, 'fake-hunting request:', JSON.stringify({
    message_id: body.message_id, N: body.N, request_id: body.request_id,
    textLength: (body.text || '').length
  }));
  const respond = (status, payload) => {
    console.log(rid, 'fake-hunting response:', status, JSON.stringify(payload));
    return res.status(status).json({ ...payload, requestId: rid });
  };

  try{
    const { message_id, text, message_link, N, request_id } = body;
    const missing = ['message_id', 'text', 'message_link', 'N']
      .filter(f => body[f] === undefined || body[f] === null || body[f] === '');
    if(missing.length){
      return respond(400, { error: `Missing required field(s): ${missing.join(', ')}` });
    }
    const count = Number(N);
    if(!Number.isInteger(count) || count < 1 || count > MAX_FAKE_HUNT_N){
      return respond(400, { error: `N must be an integer between 1 and ${MAX_FAKE_HUNT_N}` });
    }

    if(count !== FAKE_HUNT_N){
      console.log(rid, `orchestrator asked for N=${count}; using our fan-out of ${FAKE_HUNT_N}`);
    }

    // The orchestrator may retry; never message people twice for one alert.
    const seenRef = db.collection(FAKE_HUNT_MESSAGES).doc(String(message_id).slice(0, 200));
    const seen = await seenRef.get();
    if(seen.exists){
      const prev = seen.data();
      return respond(200, {
        ok: true, flow: 'fake_hunting_individuals',
        drawn_count: prev.drawnCount || 0, deduplicated: true,
        wordings_needed: FAKE_HUNT_N * WORDINGS_PER_PERSON
      });
    }

    // The offending post's own URL identifies the network; message_link often
    // points at a news article instead, which identifies nothing. Take it from
    // the payload when sent, otherwise from the stored alert.
    const alertDoc = await db.collection(FAKE_HUNTING_ALERTS)
      .doc(String(message_id).slice(0, 200)).get().catch(() => null);
    const postUrl = body.post_url
      || (alertDoc && alertDoc.exists ? alertDoc.data().post_url : null)
      || null;
    // The specific post's own words, when the orchestrator can supply them.
    // With these, the wordings answer what the post actually says — including
    // claims it adds on top of the base fake — instead of the abstract claim.
    const postText = String(body.post_text
      || (alertDoc && alertDoc.exists ? alertDoc.data().post_text : '')
      || '').slice(0, 2000);
    // Pre-generated wordings from the fake-finding server, via the
    // orchestrator. Preferred over local generation whenever present.
    const providedVariants = body.debunk_variants
      || (alertDoc && alertDoc.exists ? alertDoc.data().debunk_variants : null)
      || null;

    // Only people who asked for this network are drawn — even if that means
    // fewer than N. Messaging someone about a network they don't use is the
    // thing this preference exists to prevent.
    const network = body.network || networkFromUrl(postUrl) || networkFromUrl(message_link);
    if(network) console.log(rid, `network for this alert: ${network}`,
      body.network ? '(from payload)' : (networkFromUrl(postUrl) ? '(from post_url)' : '(from message_link)'));

    // Link to the debunk PWA rather than pasting the raw alert text: it shows
    // the claim, the ready-made rebuttal, and a button that copies it and
    // opens the offending post.
    const alertText = String(text).replace(/https?:\/\/\S+/g, '');
    const [claimPart, debunkPart] = alertText.split(/\n\s*Debunk\s*:/i);
    const claim = claimPart.replace(/^\s*\[.*?\]\s*/, '').trim();
    const debunk = (debunkPart || '').trim();

    // dry_run: the entire pipeline runs — selection, grounding, wording
    // generation, storage — but nothing is sent and no selection is recorded.
    // Exists because three separate "small tests" have now messaged real
    // volunteers; a test path that cannot reach a human is the only kind that
    // is safe to use casually.
    const dryRun = body.dry_run === true;

    const recipients = await selectRecipients(FAKE_HUNT_N, network, claimKeyOf(claim));
    if(!recipients.length){
      return respond(409, {
        error: network
          ? `No eligible recipients for network "${network}" in the Fake Hunting pool`
          : 'No eligible recipients in the Fake Hunting pool',
        reason: 'no_recipients'
      });
    }

    // Everyone drawn for one alert posting the same sentence looks like a
    // coordinated campaign, so each recipient gets a different wording.
    // Failure here is not fatal: without variants they share the original.
    // X counts characters, so a debunk written for Facebook won't fit there.
    const NETWORK_CHAR_LIMITS = { x: 280 };
    // The published reply carries a link to the debunk source. X shortens every
    // URL to a fixed 23 characters no matter how long it really is, so reserve
    // exactly that plus the newline before it — otherwise the wording fits on
    // its own and then overflows once the link is appended.
    const X_URL_COST = 23;
    const limit = NETWORK_CHAR_LIMITS[network] || null;
    const maxChars = limit ? limit - (X_URL_COST + 1) : null;
    if(limit) console.log(rid, `character budget: ${maxChars} for the wording + ${X_URL_COST + 1} for the source link = ${limit}`);

    // How many recipients we can serve with a private block of wordings each.
    let servable = 0;
    if(debunk){
      try{
        servable = await variantsFor(message_id, debunk, recipients.length, maxChars, claim, postUrl, postText, providedVariants);
      }catch(e){
        console.error(rid, 'variant generation failed:', e.message);
      }
    }

    if(servable === -2){
      const problem = `ההפרכה של ההתראה "${truncate(claim, 80)}" ארוכה מדי לרשת `
        + `${network || '(לא ידועה)'} (${debunk.length} תווים), ולא ניתן היה לקצר אותה. `
        + `לא נשלחה — יש לקצר את טקסט ההפרכה במקור.`;
      await sendAlert(`too-long:${message_id}`, problem, rid);
      return respond(409, { error: problem, reason: 'debunk_too_long' });
    }

    if(servable === -1){
      const problem = `ההפרכה של ההתראה "${truncate(claim, 80)}" לא מציינת מי עשה את הפעולה, `
        + `ואי אפשר לקבוע זאת מהטענה. לא נשלחה — יש להוסיף את השם לטקסט ההפרכה.`;
      await sendAlert(`ambiguous:${message_id}`, problem, rid);
      return respond(409, { error: problem, reason: 'ambiguous_debunk' });
    }
    const variantCount = servable;

    // No two people may receive the same wording. If generation produced
    // nothing usable there is exactly one wording — the original — so only
    // one person can be messaged.
    const canServe = servable || 1;
    if(canServe < recipients.length){
      console.log(rid, `wordings cover ${canServe} of ${recipients.length} recipients — trimming`);
      recipients.length = canServe;
    }

    const linkFor = index => {
      const base = `${DEBUNK_PWA_URL}/?message_id=${encodeURIComponent(message_id)}`;
      return variantCount ? `${base}&v=${index}` : base;
    };
    const messageFor = index =>
      `🔍 זוהה פוסט מטעה שכדאי להפריך 👇\n\n${truncate(claim)}\n\n`
      + `לחצו כאן להפרכה מוכנה:\n${linkFor(index)}`;
    if(dryRun){
      return respond(200, {
        ok: true, dry_run: true,
        flow: 'fake_hunting_individuals',
        would_send_to: recipients.length,
        variants: variantCount,
        wordings_needed: FAKE_HUNT_N * WORDINGS_PER_PERSON,
        network: network || null
      });
    }

    const delivered = [];
    const failed = [];
    for(const [index, { phone }] of recipients.entries()){
      try{
        await beacon.sendMessage({ phoneNumbers: [phone], message: forWhatsApp(messageFor(index)) });
        delivered.push(phone);
        await db.collection(SELECTIONS).add({
          phone, platform: 'whatsapp', messageId: message_id, flow: 'fake-hunting',
          claimKey: claimKeyOf(claim),
          variant: variantCount ? index : null,
          selectedAt: FieldValue.serverTimestamp()
        });
      }catch(e){
        failed.push(phone);
        console.error(rid, 'fake-hunting WhatsApp send failed:', e.message);
      }
    }

    if(!delivered.length){
      return respond(500, { error: 'WhatsApp send failed for every drawn recipient' });
    }

    await seenRef.set({
      drawnCount: delivered.length, requestedN: count, failedCount: failed.length,
      requestId: rid, correlationId: request_id || null,
      at: FieldValue.serverTimestamp()
    });

    return respond(200, {
      ok: true,
      flow: 'fake_hunting_individuals',
      drawn_count: delivered.length,
      variants: variantCount,
      // How many distinct wordings we want per alert, as configured right now.
      // The fake-finding server generates before it can ask us, so it cannot
      // know this in advance — but it can read it from any response and use it
      // for the next alert. That keeps the two sides aligned without a config
      // handshake, and without coupling generation to our availability.
      wordings_needed: FAKE_HUNT_N * WORDINGS_PER_PERSON,
      ...(failed.length ? { failed_count: failed.length } : {})
    });
  }catch(err){
    console.error(rid, err);
    return respond(500, { error: 'Internal error' });
  }
});

// Lists the WhatsApp groups Beacon can post to, so group ids can be wired
// into content_providers. Authenticated like the rest of the service; the
// Beacon secret stays inside the container.
app.get('/api/whatsapp-groups', async (req, res) => {
  if(!beacon.isConfigured()){
    return res.status(503).json({ error: 'Beacon credentials are not configured' });
  }
  try{
    const [groups, connections] = await Promise.all([
      beacon.listGroups(),
      beacon.listConnections().catch(() => [])
    ]);
    res.json({
      connections,
      groups: groups.map(g => ({
        groupId: g.groupId,
        groupName: g.groupName,
        participants: g.participantCount,
        canPost: g.tenantCanPost,
        isAdmin: g.tenantIsAdmin
      }))
    });
  }catch(err){
    res.status(502).json({ error: err.message });
  }
});

// Beacon accepts sends with no WhatsApp session linked, so an outage is
// invisible until someone notices posts missing. This endpoint is polled by
// Cloud Scheduler: it alerts on Signal when the connection drops, and again
// when it comes back. Signal is the right channel for this alert precisely
// because WhatsApp is the thing that is broken.
const WHATSAPP_STATE = 'whatsapp-connection';

app.get('/api/check-whatsapp', async (req, res) => {
  const rid = requestId();
  if(!beacon.isConfigured()){
    return res.status(503).json({ error: 'Beacon credentials are not configured' });
  }

  let connected;
  let list;
  try{
    list = await beacon.listConnections();
    const connections = Array.isArray(list) ? list : (list && list.items) || [];
    connected = connections.length > 0;
  }catch(e){
    // A failed status call is not proof of an outage; log and stay quiet.
    console.error(rid, 'connection check failed:', e.message);
    return res.status(200).json({ ok: false, checked: false, error: e.message });
  }

  const ref = db.collection(CONFIG).doc(WHATSAPP_STATE);
  const snap = await ref.get();
  const wasConnected = snap.exists ? snap.data().connected !== false : true;

  // Every transition gets one log line. Without this the only trace an outage
  // leaves is failed send attempts, which cluster inside a single outage and so
  // cannot answer "are disconnections becoming rarer?".
  if(connected !== wasConnected){
    console.log(rid, connected
      ? 'whatsapp_state_change connected=true'
      : 'whatsapp_state_change connected=false');
  }

  if(!connected){
    await sendAlert('whatsapp-disconnected',
      'חיבור הוואטסאפ ב-Beacon מנותק. הודעות לקבוצות ולמתנדבים לא נמסרות, וגם הרשמות חדשות לא נקלטות. יש לסרוק מחדש את קוד ה-QR בממשק של noiser.io.',
      rid, { title: 'הוואטסאפ מנותק', footer: '' });
  }else if(!wasConnected){
    // Recovery is worth saying out loud: otherwise the last thing anyone saw
    // was an alarm.
    await db.collection(ALERTS).doc('whatsapp-disconnected').delete().catch(() => {});
    await sendAlert('whatsapp-reconnected',
      'חיבור הוואטסאפ ב-Beacon חזר לפעול. שים לב שהודעות והרשמות מתקופת הניתוק לא ישוחזרו מעצמן.',
      rid, { title: 'הוואטסאפ חזר ✅', footer: '' });
    await db.collection(ALERTS).doc('whatsapp-reconnected').delete().catch(() => {});
  }

  await ref.set({ connected, checkedAt: FieldValue.serverTimestamp() }, { merge: true });
  res.json({ ok: true, connected, changed: connected !== wasConnected });
});

// Operator-to-operator messages, to a fixed allowlist. See src/notify.js for
// why the recipients are pinned rather than passed in freely.
app.post('/api/notify', async (req, res) => {
  const rid = requestId();
  const checked = notify.validate(req.body);
  if(!checked.ok){
    console.log(rid, 'notify refused:', checked.error);
    return res.status(checked.status).json({ error: checked.error });
  }

  const results = [];
  for(const phone of checked.phones){
    const label = notify.phoneLabel(phone);
    try{
      await beacon.sendMessage({ phoneNumbers: [phone], message: checked.message });
      console.log(rid, `notify sent to ${label}`);
      results.push({ phone: label, ok: true });
    }catch(e){
      console.error(rid, `notify to ${label} failed:`, e.message);
      results.push({ phone: label, ok: false, error: e.message });
    }
  }
  res.json({ ok: results.every(r => r.ok), results });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`signal-broadcast listening on ${port}`));
