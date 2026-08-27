# Integrating with signal-broadcast — guide for the backend team

*(Hebrew version: INTEGRATION.he.md)*

## What the service does

A Cloud Run service named `signal-broadcast`, running in the `torino-social`
project (region: `europe-west1`). It receives one HTTP call and sends a Signal
message containing the Yoriki-Light link to the Signal group mapped to the
content provider. Instead of writing the link to a log file for manual
copy-paste, call the service and it sends the message itself.

## The call

```
POST https://signal-broadcast-658282975646.europe-west1.run.app/api/broadcast
Content-Type: application/json

{
  "document_id": "I7iP9eviU22W6X3fuXhC",
  "provider_id": "hamal_behirot"
}
```

### Fields

| field | required? | meaning |
|---|---|---|
| `document_id` | yes | The `social-reactions` doc id — the same id that goes into the Yoriki-Light link today |
| `provider_id` | yes* | Content provider id — the doc id in the `content_providers` table (e.g. `hamal_behirot`) |
| `channel_id` | yes* | Alternative to `provider_id`: the Slack channel id stored on the provider doc (e.g. `C0AQN7L62EB`) |
| `post_text` | no | Snippet text for the message; if omitted, the doc's `postDescription` is used |

\* Send one of the two — whichever you have handy. If you only have the Slack
channel id, that's enough.

### Success response

```json
{ "ok": true, "flow": "group", "signalGroupId": "...", "requestId": "..." }
```

## Authentication

The service is closed — it only accepts calls carrying a Google identity
token. Two steps:

1. Send us the service-account address your code runs as (e.g.
   `xxx@torino-social.iam.gserviceaccount.com`) — we'll grant it
   `roles/run.invoker`.
2. In your code, add an `Authorization: Bearer <ID_TOKEN>` header, with the
   audience set to the service URL. From inside GCP (Cloud Run / Functions /
   GCE) you get the token like this:

```
GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https://signal-broadcast-658282975646.europe-west1.run.app
Header: Metadata-Flavor: Google
```

(In Node, simpler with the `google-auth-library` package:
`new GoogleAuth().getIdTokenClient(url)` — it handles everything.)

## What must be configured for the message to actually go out

The provider's doc in `content_providers` needs at least one destination —
Signal, WhatsApp, or both. One `/api/broadcast` call delivers to both.

**Signal** — `signal_group_id`. One-time setup per channel:

1. Add the bot number **+972 55-9761823** (shows up as "Yoriki") as a member
   of the channel's Signal group.
2. We fetch the group id and store it on the provider doc.

**WhatsApp** — `whatsapp_group_id`, a Beacon group id such as
`120363412662305778@g.us`. Sending goes through the Beacon platform:

1. Add Beacon's WhatsApp number **+972 52-434-2846** to the WhatsApp group.
2. We fetch the group id from Beacon and store it on the provider doc.

**Several groups, filtered by network** — instead of a single field, use
`signal_targets` / `whatsapp_targets`:

```json
[
  { "group_id": "…" },
  { "group_id": "…", "networks": ["x"] },
  { "group_id": "…", "networks": ["facebook", "instagram"] }
]
```

The network comes from the post document's `socialMedia` field; a target
without a filter receives everything.

A provider with no destination gets a 409 error with an explanation. A
WhatsApp failure does **not** fail the broadcast — Signal has already been
delivered, and the response carries a `whatsappError` field.

## Common errors

| code | meaning |
|---|---|
| 400 | Missing `document_id` or provider identifier |
| 401/403 | Auth problem — the service account wasn't granted access, or the token is invalid |
| 404 | Provider not found in `content_providers` |
| 409 | Provider has no `signal_group_id` (or: no opted-in users, on the fake-hunt flow) |

Every response includes a `requestId` — include it when reporting a problem.
