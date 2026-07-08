# `GET /post-info` — Fetch post context for the web app

Proposed addition to the `claim-social-reactions` service, matching its existing conventions.

## Request

```
GET /post-info?document_id=UtFVB84G8Jx7WdnYvaPY
```

- `document_id` (required, query param) — same Firestore document id used by the claim/return-unused endpoints.

## Success response — HTTP 200

```json
{
  "document_id": "UtFVB84G8Jx7WdnYvaPY",
  "post_url": "https://x.com/ItaiBenZvi/status/2071141418093986171?s=20",
  "post_snippet": "כמה זמן עוד אפשר למכור לנו סיפורים על אחדות...",
  "requestId": "…"
}
```

- `post_url` (string) — canonical post URL, used to trigger the OS-level app handoff after the user posts a reply.
- `post_snippet` (string) — post text/summary shown to the user. Source: the `postDescription` field on the Firestore doc (collection `social-reactions`, project `phobos-01`).

The web app also accepts the raw Firestore field names (`postDescription`, `postUrl`) in the response, so returning the document fields as-is works too.

## Error responses

- `400` — missing `document_id`
- `404` — document not found
- `500` — server error

Same `error`/`requestId` body shape as the existing endpoints. CORS: `GET, OPTIONS`, no auth, matching the rest of the service.

## Why GET, not POST

It's a pure read with no side effects, so GET is idiomatic and cacheable — useful since the same link may be opened/previewed multiple times.

## Web app integration

Until this endpoint exists, the web app reads `post_url` / `post_snippet` directly from its own URL query params (set by whoever generates the link). Once this endpoint is live, the web app calls it with `document_id` and prefers its response, falling back to the URL params if the call fails — see `fetchPostInfo()` in `index.html`.
