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
| **`uniqueOpens`** | **how many people opened this post** |
| **`uniqueCopyOpen`** | **how many people pressed העתק ופתח** |
| `opens` | raw link taps, including the same person returning |
| `copyOpen` | raw presses, including the same person pressing twice |
| `styleSelected` | times a reply style was chosen/changed |
| `declines` | pressed **לא, תודה** |
| `exhausted` | hit "no suggestions available" (reserved; a health signal) |
| `lastEventAt` | timestamp of the most recent event |

**Use the `unique*` fields for headline numbers** — they answer "how many
people", which is almost always what a reader of the dashboard wants. The
raw counters are useful for spotting repeat engagement.

"A person" means a distinct browser/device: an anonymous random id stored
locally on the device. Same person on two devices counts twice; a shared
device counts once. The `sessions` and `copiers` subcollections hold those
ids as document keys (nothing else) and can be ignored by the dashboard.

## Suggested panel

Per broadcast (join `broadcast-log` → `pwa-stats` by document id):

```
when              channel           people  pressed  rate    opens  presses
2026-07-30 16:49  hamal_behirot         98       54   55%      142       61
```

`rate = uniqueCopyOpen / uniqueOpens` is the key metric. **Do not show a
percentage of recipients**: messages are forwarded manually to WhatsApp
groups too, so the number of people who received a link is unknown.

Useful aggregates: totals per provider over time, and how many of the people
who opened got as far as choosing a style.

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

השדות המרכזיים: **`uniqueOpens`** (כמה אנשים פתחו את הפוסט) ו-**`uniqueCopyOpen`**
(כמה אנשים לחצו ״העתק ופתח״) — אלה המספרים להצגה. בנוסף: `opens` ו-`copyOpen`
(סכומים גולמיים, כולל אותו אדם שחוזר), `styleSelected`, `declines`, `lastEventAt`.

״אדם״ = מכשיר/דפדפן נפרד, לפי מזהה אקראי ואנונימי שנשמר במכשיר.

**חשוב:** אין להציג אחוז מתוך מקבלי ההודעה — ההודעות מועברות ידנית גם
לקבוצות וואטסאפ, ולכן מספר הנמענים אינו ידוע. המדד הנכון הוא
`copyOpen / uniqueOpens`.

אין עוגיות, אין מזהי משתמש, אין כתובות IP ואין כלים חיצוניים — רק מונים
מצטברים לכל פוסט.

</div>
