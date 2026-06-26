# Reply Assistant — WhatsApp-linked PWA

A PWA that opens from a WhatsApp link and suggests a personalized reply to a
social post. This is a front-end prototype with mocked data — see "What's
mocked / what you need to build" below before using it with Claude Code.

## Files

- `index.html` — the entire app (HTML/CSS/JS in one file). Hebrew, RTL.
- `manifest.json` — PWA manifest (installable, standalone display).
- `service-worker.js` — minimal app-shell caching for offline/installability.
- `icons/` — app icons (192px, 512px).

## How it works (current prototype)

1. **Style cookie, not login.** On first visit, "Get a suggestion" is
   disabled and a banner prompts the user to pick their style. They choose
   gender (זכר / נקבה) and tone (ציני / רגשי / ממלכתי / אגרסיבי) in a
   full-screen panel. This is saved as a 2-year cookie — no account, no
   login. Editing later reopens the same panel, pre-filled.
2. **Suggestion card.** Once a style is set, a suggested reply loads
   automatically, styled like a tear-off note. "הצעה אחרת" (try another)
   cycles to a different option for the same tone.
3. **On accept:** copies the suggestion to the clipboard, then immediately
   navigates to the original post's URL (`MOCK_CONTEXT.postUrl`). No
   device/app detection is needed for this — iOS Universal Links and
   Android App Links handle "open the native app if installed, else the
   browser" automatically for any real `https://` URL. The navigation
   happens in the same click handler, with no `setTimeout` delay, because
   iOS requires that to preserve the user-gesture context.

## What's mocked / what you need to build

This file mocks two things that need to become real backend endpoints:

```js
// Currently a hardcoded object — replace with:
// GET /api/context?token=...
const MOCK_CONTEXT = {
  source: 'linkedin.com',
  snippet: '...',
  postUrl: 'https://...'   // the real canonical post URL
};

// Currently returns from a hardcoded table — replace with:
// GET /api/suggestion?token=...&tone=...&index=...
function fetchSuggestion(tone, index) { ... }
```

### Link/token design (from our planning conversation)

- **Bootstrap problem:** a WhatsApp group message shows the same link to
  everyone — there's no way to embed a different token per recipient in one
  group post. So identity here is *not* established by a server-issued
  token; it's self-declared via the style picker, then remembered via
  cookie. This means you don't know "who" tapped, only "what style this
  browser asked for."
- **If you later need to know the real person** (e.g. to avoid duplicate
  registration, or to message them individually), add a name/phone field to
  the same style panel — the rest of the architecture doesn't change.
- **Cookie scope risk:** in-app browsers (WebViews) sometimes use a cookie
  jar separate from the system browser. We confirmed WhatsApp's own in-app
  browser (IAB) only applies to CTA-button links in *templated* WhatsApp
  Business marketing/utility messages sent by high-volume accounts — a
  regular personal/group message link opens in the system browser (Safari/
  Chrome) and behaves like normal cookies. Re-verify this if you switch to
  the Business API later.

### Suggested next steps for Claude Code

1. Stand up the two API endpoints above (any backend stack is fine — this
   front end has zero framework dependencies).
2. Server-side, use the Claude API to generate the actual suggestion text
   from the post content + the user's saved style.
3. Decide on token/link format for the *initial* WhatsApp message (e.g. a
   short-lived signed token if you ever do need 1:1 identification later).
4. Test the accept→redirect flow on a real iOS and Android device — the
   Universal Links/App Links handoff can't be verified in a desktop
   browser preview.
