# beacon-webhook

Receives inbound WhatsApp messages from Beacon so people can join the Fake
Hunting pool and choose which networks they want alerts for, by messaging the
bot (+972 52-434-2846). Runs on Cloud Run in **torino-social**.

Public by necessity — Beacon cannot present a Google ID token — so every
request must pass HMAC verification before it is trusted. `signal-broadcast`
stays private and is untouched by this.

## Verification

Beacon signs each delivery with HMAC-SHA256 over `<timestamp>:<rawBody>` and
sends `x-beacon-hmac: sha256=<hex>` plus `x-beacon-timestamp` (epoch seconds).
We verify against the raw bytes, enforce a ±300s window, and compare in
constant time; anything else gets a 401. See `src/verify.js`.

**The work runs before the response.** Cloud Run throttles CPU once a response
is sent, so acknowledging first means the opt-in never gets written.

## The PrivateMessageReceived payload

Confirmed against a real event — `from` is an **object**, not a string:

```json
{
  "id": "evt_…", "createdAt": "…", "type": "PrivateMessageReceived", "apiVersion": "v1",
  "data": {
    "id": "…", "body": "הכל",
    "from": { "phoneNumber": "972547554469", "whatsappUserId": "972547554469@c.us",
              "firstName": "…", "nickname": "…", "beaconId": "co_…" },
    "to": "972524342846", "chatId": "…@c.us", "type": "chat",
    "timestamp": "…", "hasMedia": false
  }
}
```

`phoneNumber` arrives without a `+`. Anything we can't parse is stored in
`beacon-webhook-events` so the shape can be corrected and the event replayed.

## What a message does

`src/preferences.js` parses plain Hebrew ("רק פייסבוק ואינסטה", "אקס בלבד",
"הכל", "הסר"). The result is written to `fake-hunt-optins/whatsapp:<phone>`
as `{ platform, phone, active, networks[], joinedAt, updatedAt }`, and the
bot replies with a confirmation naming what was recorded. A later message
replaces the earlier choice; "הסר" sets `active: false`.

Joining without naming networks means **all** networks — the confirmation
explains how to narrow it.

## Secrets

- `beacon-webhook-secret` — shared with Beacon at registration time.
  **Store it with no trailing newline**: `console.log` adds one, and the byte
  mismatch makes every signature fail.
- `beacon-client-secret` — used to send the confirmation reply.

## Registration

`POST https://api.noiser.io/v1/webhook` with `{ url, types, secret }` using an
OAuth client-credentials token. Currently registered for
`PrivateMessageReceived`; confirm with `GET /v1/webhook`.

## Still to build

- Drawing WhatsApp recipients for Fake Hunting alerts from this pool (the
  Signal path already works; `fetchPool` filters by the stored `networks`).
