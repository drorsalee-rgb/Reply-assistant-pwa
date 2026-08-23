// Beacon (noiser.io) — WhatsApp delivery.
//
// Auth is OAuth2 client-credentials against Beacon's Keycloak; the token is
// cached until shortly before it expires. The client secret is never stored
// in this repo — it arrives as an env var, mounted from GCP Secret Manager.

const TOKEN_URL = process.env.BEACON_TOKEN_URL
  || 'https://auth.noiser.io/realms/Beacon/protocol/openid-connect/token';
const API_BASE = process.env.BEACON_API_URL || 'https://api.noiser.io/v1';
const CLIENT_ID = process.env.BEACON_CLIENT_ID || '';
const CLIENT_SECRET = process.env.BEACON_CLIENT_SECRET || '';

let cachedToken = { value: null, expiresAt: 0 };

function isConfigured(){
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function getToken(){
  if(cachedToken.value && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'openid'
    })
  });
  if(!res.ok){
    const text = await res.text();
    throw new Error(`Beacon auth failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Refresh a little early so a request never races the expiry.
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in || 60) - 30, 10) * 1000
  };
  return cachedToken.value;
}

async function request(path, options = {}){
  const token = await getToken();
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if(!res.ok){
    const text = await res.text();
    throw new Error(`Beacon ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// The WhatsApp numbers this Beacon tenant can send from.
async function listConnections(){
  return request('/whatsapp/connections');
}

// WhatsApp groups Beacon can see, with whether we're allowed to post.
// The API's page numbering isn't documented, so probe page 0 first and fall
// back to 1 — asking for the wrong first page silently returns nothing.
async function listGroups({ pageSize = 100, maxPages = 10 } = {}){
  const fetchPage = async page => {
    try{
      const data = await request(`/groups?page=${page}&pageSize=${pageSize}`);
      return (data && data.items) || [];
    }catch(e){
      return null;   // that page number isn't accepted
    }
  };

  let firstPage = 0;
  let items = await fetchPage(0);
  if(!items || !items.length){
    const alt = await fetchPage(1);
    if(alt && alt.length){ firstPage = 1; items = alt; }
  }
  if(!items) return [];

  const all = [...items];
  for(let page = firstPage + 1; page < firstPage + maxPages; page++){
    if(items.length < pageSize) break;
    items = await fetchPage(page);
    if(!items || !items.length) break;
    all.push(...items);
  }
  return all;
}

// Group ids look like "123456789-987654321@g.us" or "123456789@g.us".
const GROUP_ID_PATTERN = /^\d+(?:-\d+)?@g\.us$/;

async function sendMessage({ groupIds = [], phoneNumbers = [], message, from }){
  if(!isConfigured()) throw new Error('Beacon credentials are not configured');
  if(!message) throw new Error('Beacon message content is empty');

  const to = groupIds.length
    ? { type: 'group', ids: groupIds }
    : { type: 'private', phoneNumbers };
  if(to.type === 'group'){
    const bad = groupIds.filter(id => !GROUP_ID_PATTERN.test(id));
    if(bad.length) throw new Error(`Invalid WhatsApp group id(s): ${bad.join(', ')}`);
  }

  const body = {
    to,
    // Beacon caps message content at 4096 characters.
    body: { messageType: 'text', content: message.slice(0, 4096) }
  };
  if(from && from.length) body.from = from;

  return request('/whatsapp/messages', { method: 'POST', body: JSON.stringify(body) });
}

module.exports = { isConfigured, listConnections, listGroups, sendMessage, GROUP_ID_PATTERN };
