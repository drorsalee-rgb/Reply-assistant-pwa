# signal-broadcast

Receives a broadcast trigger and sends Signal messages containing a
reply-assistant PWA link. Runs on Cloud Run in the **torino-social** GCP
project (same project as the reactions engine and Firestore data).

## Flows

`POST /api/broadcast` with `{ document_id, provider_id?, channel_id?, post_text? }`
(one of `provider_id` / `channel_id` required). The provider is looked up in the
**existing** `content_providers` collection — by doc id (`provider_id`) or by
its Slack `channel_id` field. Fields this service expects to be ADDED to
provider docs:

| field on `content_providers/{provider_id}` | behavior |
|---|---|
| `signal_group_id: "..."` | One message to that Signal group with a link to the main PWA. |
| `signal_targets: [...]` | Several Signal groups, each optionally filtered by network (see below). Overrides `signal_group_id`. |
| `whatsapp_group_id: "…@g.us"` | Also send to that WhatsApp group, through Beacon. |
| `whatsapp_targets: [...]` | Several WhatsApp groups with the same per-network filters. Overrides `whatsapp_group_id`. |
| `shared_group_ok: true` | Marks an intentional merge, so two providers sharing a group don't raise the conflict alert. |
| `broadcast_type: "fake-hunt"` (+ optional `fan_out_cap`, default 4) | Weighted-random selection from `fake-hunt-optins`; each gets a 1:1 DM with a link to the debunk PWA. Selections logged to `fake-hunt-selections`, deprioritizing recently-picked users. |

Signal and WhatsApp are independent: a provider may have either, or both. A
WhatsApp failure never fails a broadcast Signal already delivered — it is
reported in the response (`whatsappError`) and raises an alert.

### Targets with network filters

Both `signal_targets` and `whatsapp_targets` take the same shape, so one post
can fan out to a merged group plus per-network groups:

```json
[
  { "group_id": "…" },
  { "group_id": "…", "networks": ["x"] },
  { "group_id": "…", "networks": ["facebook", "instagram"] },
  { "group_id": "…", "exclude_networks": ["facebook"] }
]
```

The network is the post document's `socialMedia` value (`twitter` is treated
as `x`). No filter means every network. WhatsApp group ids come from Beacon
and look like `120363412662305778@g.us`; list them with
`GET /api/whatsapp-groups` on this service.

`document_id` must reference an existing `social-reactions` doc (created by
the reactions engine). The message snippet is `post_text` if provided, else
the doc's `postDescription`.

## Firestore collections (owned by this service)

- `broadcast-channels` — channel_id → routing config (see above)
- `fake-hunt-optins` — doc id = phone number (`+972...`), `{ active: true, joinedAt }`
- `fake-hunt-selections` — append-only log for the weighted random
- `broadcast-log` — audit log of every broadcast call

## Environment

- `SIGNAL_API_URL` — base URL of a signal-cli-rest-api instance. **Unset = stub
  mode**: sends are logged, not sent (safe for dev).
- `SIGNAL_NUMBER` — the bot's number (default +972559761823)
- `PWA_BASE_URL` — default https://yoriki-500811.web.app
- `DEBUNK_PWA_URL` — default `$PWA_BASE_URL/debunk`
- `BEACON_CLIENT_ID` — Beacon (noiser.io) public API client id
- `BEACON_CLIENT_SECRET` — mounted from Secret Manager (`beacon-client-secret`),
  never stored in this repo. **Unset = WhatsApp sending is skipped.**
- `ALERT_PHONES`, `ALERT_GROUP_ID` — where misconfiguration alerts are sent
- `ATTACH_LOGO=true` — attach the network's logo as an image (off by default;
  the message names the network in text instead)

## Signal account

The bot number **+972559761823** was registered with signal-cli (locally, on
the Mac mini — account data in `~/.local/share/signal-cli`). Production needs
a signal-cli-rest-api container with a copy of that directory mounted at
`/home/.local/share/signal-cli`. The account expects regular `receive` calls;
the container in `json-rpc` mode handles that automatically.

## Deploy

```
gcloud run deploy signal-broadcast --source . \
  --project torino-social --region europe-west1 \
  --set-env-vars SIGNAL_API_URL=...,SIGNAL_NUMBER=+972559761823
```

## Not yet done

- signal-cli-rest-api deployment (needs persistent disk — small GCE VM
  recommended; Cloud Run has no persistent state for the Signal keys)
- Debunk PWA (`/debunk` on the hosting site) — pending data contract for the
  debunk text + explanation URL
- Opt-in flow for the fake-hunt pool (silent Signal group pattern; see the
  reply-assistant README's use case 2)
- Auth on /api/broadcast (currently open; add a shared secret or IAM before
  exposing publicly)

## Fake Hunting — personal messages to N individuals

`POST /api/broadcast-fake-hunting`, called by the **fake-hunting-orchestrator**
after each alert. Unlike the group flow, it messages people one by one so the
selection stays invisible to everyone else.

```json
{
  "message_id": "…",
  "text": "…",
  "message_link": "https://…",
  "post_url": "https://x.com/…",
  "N": 5,
  "request_id": "…",
  "network": "x"
}
```

| field | required | meaning |
|---|---|---|
| `message_id` | yes | id of the `fake-hunting-messages` document; also the dedupe key |
| `text` | yes | `[FAKE CLAIM ALERT] <claim>` then `Debunk: <rebuttal>` |
| `message_link` | yes | where the debunk was published (often a news article) |
| `post_url` | no | the offending post itself — part of the Ilan → orchestrator contract. Used for the "copy and open" button and to identify the network. Falls back to the `post_url` on the alert document when omitted. |
| `N` | yes | how many individuals to notify |
| `request_id` | no | correlation id |
| `network` | no | overrides the network derived from `post_url` / `message_link` |

`post_url` and `message_link` are **not** interchangeable: the button opens
`post_url`, while `message_link` is offered as "source of the debunk".

Returns `{ ok, flow: "fake_hunting_individuals", drawn_count, requestId }`;
`400` on a bad body, `409` with `reason: "no_recipients"` on an empty pool,
`500` if every send failed. Repeating a `message_id` returns the original
result with `deduplicated: true` instead of messaging anyone again, so an
orchestrator retry can never double-send.

**Recipient list** (the open question in the orchestrator's spec): the pool is
the membership of a designated Signal group — people opt in by joining it, and
the group itself stays silent. Configure it at
`broadcast-config/fake-hunting.signal_group_id`, or with `FAKE_HUNT_GROUP_ID`.
With neither, it falls back to the `fake-hunt-optins` collection.

Selection is weighted random: anyone messaged in the last 30 days is
deprioritized (`weight = 1 / (1 + picks)²`), so over time the load spreads
evenly across the pool. Every pick is logged to `fake-hunt-selections`.

**No two recipients ever get the same wording.** Each alert's debunk is
rephrased into distinct variants, and every recipient is assigned a private
block of three of them (`perPerson`) addressed by the `v=` slot in their
link. Browsing alternatives in the PWA moves within that block only, so it
can never reach the text handed to someone else. If there aren't enough
wordings for everyone drawn, the alert goes to *fewer people* rather than
repeating one — `drawn_count` reports how many were actually messaged.

### Network preferences (WhatsApp Fake Hunting)

Participants say which networks they want alerts for by messaging the bot in
plain language ("רק פייסבוק ואינסטה", "אקס בלבד", "הכל", "הסר"); a later
message replaces the earlier choice, and the bot confirms what it recorded.
`src/preferences.js` parses those messages.

- Someone who joins without naming networks receives **everything**, and the
  confirmation explains how to narrow it.
- The network is normally **derived from `message_link`** — a link to x.com,
  facebook.com, instagram.com, tiktok.com or youtube.com identifies itself, so
  the orchestrator needs no extra field. An explicit `network` in the payload
  overrides it; a link to some other domain yields no network and no filtering.
- Only people who asked for that network are drawn — **even if that leaves
  fewer than `N`**; `drawn_count` reports the real number. Records with no
  stored preference count as "all networks".
- A pool derived from a Signal group's membership carries no preferences, so
  `network` has no effect there.

Still to build: the Beacon webhook receiver (`PrivateMessageReceived`) that
records opt-ins and replies with the confirmation — waiting on Beacon's
webhook-validation docs.
