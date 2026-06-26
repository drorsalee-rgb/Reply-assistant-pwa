# Reply Assistant — WhatsApp-linked PWA

A PWA that opens from a WhatsApp link and suggests a personalized reply to a
social post. It's a **"light" companion to an existing mobile app** — same
company, same general purpose (reply recommendations), but a *different
audience*: people without the app installed, reached via WhatsApp instead.

This doc captures the architecture decisions made so far, so a fresh agent
(or future you) doesn't have to reconstruct them from scratch.

## Files

- `index.html` — the entire front-end (HTML/CSS/JS in one file). Hebrew, RTL.
- `manifest.json` — PWA manifest (installable, standalone display).
- `service-worker.js` — minimal app-shell caching for offline/installability.
- `icons/` — app icons (192px, 512px).

## Product context — read this before changing the identity/data model

- **PWA users are NOT App users.** The mobile app does more, and has its own
  user base (identified by phone number via Firebase Phone Auth, with
  preferences already stored). The PWA is explicitly for *other* people —
  no installation, no login, no relation to the App's user accounts. Do not
  try to look up PWA visitors in the App's user data; they're not there.
- **No login, by design.** Style preference (gender + tone of voice) is
  self-declared once via a picker in the PWA, saved as a 2-year cookie.
  There is no way to know "which real person" tapped a link — only "what
  style this browser declared." That's an intentional tradeoff, not a gap.
- **Distribution is a WhatsApp group message**, not individual DMs. This
  matters for two reasons:
  - Everyone in the group sees the *same link* — so the token in the URL
    identifies the **post/broadcast**, not the user. Per-user personalization
    comes entirely from the cookie, not the link.
  - Confirmed: WhatsApp's in-app browser (IAB) only applies to CTA-button
    links inside *templated* WhatsApp Business marketing/utility messages
    sent by high-volume accounts. A regular personal/group message link
    opens in the system browser (Safari/Chrome), so cookies behave normally.
    Re-verify this if the sending method ever changes to the Business API.

## Current front-end flow (implemented in index.html)

1. On load, check the `style` cookie.
2. **No cookie:** "Get a suggestion" disabled, banner "בחר/י סגנון" shown.
   Tapping it (or the edit-pencil icon) opens a full-screen panel with two
   dropdowns — מגדר (זכר/נקבה) and סגנון תגובה (ציני/רגשי/ממלכתי/אגרסיבי).
   Saving writes the cookie and unlocks the suggestion flow.
3. **Cookie present:** suggestion loads automatically. "הצעה אחרת" cycles to
   another option. The edit-pencil reopens the panel pre-filled, for anyone
   who wants to change their style later.
4. **On accept ("העתק/י תגובה")**: copies the suggestion to the clipboard,
   then immediately navigates to the post's real URL
   (`MOCK_CONTEXT.postUrl`). No device/app detection needed — iOS Universal
   Links / Android App Links handle "open the app if installed, else the
   browser" automatically for any real `https://` URL. The navigation must
   stay in the same click handler (no `setTimeout`) to preserve the
   user-gesture context iOS requires for this to work.

## Backend architecture (not yet built — this is the spec)

```
WhatsApp group link
      │
      ▼
 PWA (Firebase Hosting)
      │  GET /api/context?token=...     (which post is this?)
      │  GET /api/suggestion?token=...&style=...   (the actual suggestion)
      ▼
 New thin backend (Cloud Function / Cloud Run, SAME Firebase project as the App)
      │
      ├─ Firestore: NEW collection (e.g. `pwa_sessions`), separate from the
      │   App's user collection. Stores: token → post info (source, snippet,
      │   postUrl), and optionally the cookie-token → style preference if you
      │   want it to survive beyond a single browser (see "Open questions").
      │
      └─ Calls OUT to the EXISTING recommendation backend's API (a separate
          server, not Firebase) — passing the post content/context + the
          user's style — and returns whatever it sends back as the
          suggestion text.
```

**Why same Firebase project, new collection:** reuses existing billing/
GCP credits and console access, with zero risk of mixing PWA visitors into
the App's real user data — confirmed as the simpler option over standing up
a second project.

**Why call the existing recommendation engine instead of building a new
one:** the App already has this logic running on a separate backend server
with its own API — the new PWA backend should be a thin proxy to it, not a
reimplementation.

## What's mocked right now in index.html (needs to become real)

```js
const MOCK_CONTEXT = {
  source: 'linkedin.com',
  snippet: '...',
  postUrl: 'https://...'   // replace with: GET /api/context?token=...
};

function fetchSuggestion(tone, index) { ... }
// replace with: GET /api/suggestion?token=...&tone=...&gender=...&index=...
```

## How the existing recommendation engine actually works (the "bucket" system)

For each post, the existing backend pre-generates suggestions into **8
buckets** — one per (gender × tone) combo, which happily map 1:1 onto the
PWA's style picker (2 genders × 4 tones = 8). For each App user in the
target group, it generates 4 suggestions into their matching bucket. When a
user opens the post, the app pulls 2 from the bucket (then 2 more on
request), and whichever the user *doesn't* pick gets recycled back into the
bucket for the next person.

**This creates a real risk for the PWA specifically.** Bucket size is sized
for the *known App target-group population* per post. WhatsApp/PWA traffic
is additional, unplanned demand on the exact same buckets. Unlike scattered
App users, WhatsApp group members are all replying in the *same visible
thread* — so if the bucket runs low and recycling starts repeating itself,
two different people in the group could end up posting the **identical
suggestion text** next to each other. That's the failure mode to design
around, not just "ran out of suggestions."

**Decision: feed estimated WhatsApp demand into bucket generation — but only
for *first-time* visitors, not the whole group.** A returning visitor's style
is already known (they set it on a previous visit, editable but stable
unless they change it) — so their demand can be added as an **exact count**
to their specific bucket, no estimation needed. Only people tapping the link
for the first time are genuinely unknown in advance, and that's a much
smaller number than the full group. This means: known-bucket counts (exact)
+ a smaller shared buffer across all 8 buckets for first-timers only —
instead of padding every bucket with the full group size.

**This makes server-side style storage required, not optional** (see open
question, formerly #5): the backend needs to answer "how many current
visitors have each of the 8 styles?" *before* a new post goes out — which a
browser-only cookie can't provide, since the backend never sees it until
someone actually requests a suggestion. Recommended implementation: a live
counter per bucket (one per gender×tone combo) in the new `pwa_sessions`
collection — incremented when a visitor first sets a style, and
decremented+incremented on the old/new pair if they edit it later — so
bucket generation can read 8 cheap counters instead of re-aggregating all
visitor records from scratch each time.

## Multi-group distribution and demand estimation

Posts may be broadcast to **multiple WhatsApp groups**, each with a
different, unknown click-through rate, and a single person may belong to
several of those groups. The design:

- **Group member count isn't reliably knowable, and that's OK.** WhatsApp
  doesn't expose group membership size to a third-party system — the
  options are manual lookup (someone checks the group info screen) or an
  unofficial automation library (risks ToS violation / number bans, and is
  fragile). Rather than depend on this number, demand estimation leans on
  two things that don't require it:
  - **Historical click data, for any group with prior broadcasts.** Once a
    group has been broadcast to before, you already have the *actual*
    observed click count and bucket breakdown sitting in your own data — a
    rolling average of real past outcomes is a better forecast than
    reconstructing one from an unknowable group size and an assumed ratio.
    Group size only ever mattered for brand-new groups with zero history,
    and even there a rough manual guess is enough — it doesn't need to be
    precise.
  - **The low-watermark refill mechanism (below) absorbs most of the
    remaining uncertainty in real time.** Precise upfront forecasting mainly
    matters for the *initial seed* — surviving the first burst of clicks
    right after the WhatsApp message goes out. After that, refills react to
    actual observed demand, not a forecast, so the seed only needs to be
    "enough to survive the first wave," not exact.
- **One token per (post × group)** — broadcasting a post to 3 groups means
  generating 3 separate links, not reusing one. The token's server-side
  mapping records both which post and which group it came from.
- **A visitor's persistent record gets a `groups` array**, appended to (not
  overwritten) the first time they tap a link from a group they haven't been
  seen in before. This is how the same person tapping links from two
  different groups they're in doesn't get treated as two different people.
- **For groups with broadcast history, known vs. unknown visitors still
  matters for bucket allocation, just driven by observed data instead of a
  formula:** a known visitor's eventual click (if it happens) lands in their
  specific known bucket; an unknown/first-time visitor's click can't be
  pre-assigned to a bucket. Both rates — "what fraction of known members
  click on a given broadcast" and "what fraction of never-seen members click
  for the first time" — are worth tracking per group over time, since they
  likely differ meaningfully by group (a tight 15-person team chat behaves
  very differently from a large loose community group).

## Empty-bucket handling

Ranked by reliability, not treated as three equal options:

1. **Low-watermark refill (primary, proactive).** Trigger fresh generation
   for a bucket when its remaining count drops below
   `max(absolute_floor, percentage_of_estimated_remaining_demand)` — the
   absolute floor stops small buckets from never refilling, the percentage
   stops large buckets refilling needlessly often. This should prevent most
   visitors from ever hitting an empty bucket.
2. **"Customizing your suggestion…" loading state (UX fallback for the rare
   miss).** Reuses the skeleton-loading UI already built into the front end
   — same shimmer placeholder, just held a bit longer while a refill
   completes.
3. **Recycling (opportunistic bonus, not a reliability mechanism).** Useful
   when it happens, but depends on another visitor's independent timing —
   shouldn't be the thing the empty-bucket safety net is designed around.

## Open questions to resolve before/while building the backend

1. **Does the bucket pull/recycle logic have a callable API, or is it only
   triggered internally by the App's push-notification flow?** This is
   unconfirmed — check with whoever owns that backend. If it doesn't exist
   yet, the cleanest path is adding a small dedicated HTTP API to that
   backend (e.g. `POST /buckets/pull`, `POST /buckets/recycle`) for the PWA's
   thin backend to call — rather than having two systems write directly to
   the same underlying bucket storage without a shared contract, which risks
   race conditions between App and PWA traffic competing for the same data.
2. **Where does "estimated WhatsApp group size" get fed into bucket
   generation?** Whatever triggers bucket creation for a new post (likely an
   admin action when a post is selected for distribution) needs a new input
   for this buffer. Needs to be added wherever that trigger currently lives.
3. **Recommendation engine's general API contract** — request/response
   shape, auth method (API key? bearer token?), and whether it expects
   inputs this light flow can actually provide (e.g. does it need an
   image/screenshot of the post, or is post text + URL enough?). Check with
   whoever built it.
4. **Where to store that API's credentials** — use GCP Secret Manager or
   Cloud Functions environment config; never commit them to this repo. Make
   sure `.gitignore` covers `.env` before one exists.
5. **Can the existing bucket-generation logic be re-invoked for just one
   bucket, on demand, without side effects?** The low-watermark refill (above)
   needs to call "generate more suggestions for this one bucket" after the
   initial post broadcast — worth confirming this doesn't accidentally
   re-trigger the App's push notifications or other broadcast-time logic that
   should only happen once.
6. **Server-side style storage is now required** (not optional, see bucket
   discussion above) — each visitor's style needs to live in Firestore
   (`pwa_sessions` collection), keyed by a persistent token stored in their
   cookie, with a live counter per bucket (8 total) that increments/
   decrements as visitors set or edit their style. This is what lets bucket
   generation ask "how many known visitors are in each style?" before a new
   post goes out.
7. **How does a new post's token/context get created?** Right now there's no
   defined process for "I'm about to broadcast a new post to the WhatsApp
   group — register its token + URL + snippet somewhere." Needs a simple
   admin script or endpoint to create that `pwa_sessions` entry — and now
   also needs to feed the WhatsApp group-size estimate into bucket
   generation (see above) before sending the WhatsApp message.

## Hosting plan

- **Firebase Hosting** — serves this static PWA. Free SSL, supports a custom
  subdomain (e.g. `reply.yourdomain.com`) pointed via DNS records you control,
  without touching your existing main website.
- **Cloud Functions or Cloud Run** — the thin backend described above, same
  Firebase project.
