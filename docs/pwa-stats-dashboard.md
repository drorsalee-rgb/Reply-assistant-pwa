# PWA usage stats — for the torino-social dashboard

Yoriki Light (the PWA) now reports aggregate usage counters. They live in
Firestore in the **same project as the dashboard** (`torino-social`), so the
dashboard can read them directly — no new API needed.

## Collection: `pwa-stats`

One document per post, **document id = the `social-reactions` document id**,
so it joins directly with `broadcast-log` (which records the provider each
post was broadcast to) and with `social-reactions` itself.

| field | meaning |
|---|---|
| `opens` | link taps, including reloads |
| `uniqueOpens` | distinct visits (per browser tab session) |
| `styleSelected` | users who chose/changed a reply style |
| `copyOpen` | pressed **העתק ופתח** — the conversion that matters |
| `declines` | pressed **לא, תודה** |
| `exhausted` | hit "no suggestions available" (reserved; useful as a health signal) |
| `lastEventAt` | timestamp of the most recent event |

There is also a `sessions` subcollection (random per-tab tokens, used only to
deduplicate `uniqueOpens`). It holds no personal data and can be ignored by
the dashboard.

## Suggested panel

Per broadcast (join `broadcast-log` → `pwa-stats` by document id):

```
when              channel            opens  uniq  style  copy  decline  rate
2026-07-30 16:49  hamal_behirot        142    98     71    54       12   55%
```

`rate = copyOpen / uniqueOpens` is the key metric. **Do not show a
percentage of recipients**: messages are forwarded manually to WhatsApp
groups too, so the number of people who received a link is unknown.

Useful aggregates: totals per provider over time, and `styleSelected /
uniqueOpens` (how many visitors get as far as choosing a style).

## Privacy

No cookies, no user ids, no IP addresses, no third-party analytics — only
counters per post. The per-tab token exists solely so one visit isn't counted
as several opens.

## Where the data comes from

`pwa-events` Cloud Run service (europe-west1, public endpoint, called by the
PWA with `navigator.sendBeacon`). Source: `pwa-events/` in this repo.
A CLI report is available meanwhile: `pwa-events/stats.sh`.

---

<div dir="rtl">

# בעברית — לצוות הדשבורד

ה-PWA מדווח מעכשיו על שימוש. הנתונים יושבים ב-Firestore באותו פרויקט של
הדשבורד (`torino-social`), באוסף **`pwa-stats`** — מסמך אחד לכל פוסט,
כשמזהה המסמך זהה למזהה ב-`social-reactions`, כך שאפשר להצליב ישירות מול
`broadcast-log` (שם רשום לאיזה ערוץ נשלח כל פוסט).

השדות: `opens` (פתיחות כולל רענונים), `uniqueOpens` (ביקורים נפרדים),
`styleSelected` (בחרו סגנון), `copyOpen` (**לחצו ״העתק ופתח״** — מדד ההמרה
המרכזי), `declines` (לחצו ״לא, תודה״), `lastEventAt`.

**חשוב:** אין להציג אחוז מתוך מקבלי ההודעה — ההודעות מועברות ידנית גם
לקבוצות וואטסאפ, ולכן מספר הנמענים אינו ידוע. המדד הנכון הוא
`copyOpen / uniqueOpens`.

אין עוגיות, אין מזהי משתמש, אין כתובות IP ואין כלים חיצוניים — רק מונים
מצטברים לכל פוסט.

</div>
