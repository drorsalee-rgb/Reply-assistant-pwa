<div dir="rtl">

# חיבור לשירות signal-broadcast — הסבר לצוות ה-Backend

## מה השירות עושה

שירות Cloud Run בשם `signal-broadcast`, רץ בפרויקט `torino-social` (region: `europe-west1`).
הוא מקבל קריאת HTTP אחת ושולח הודעת Signal עם הקישור ל"יוריקי לייט" — לקבוצת ה-Signal
המתאימה לספק התוכן. במקום לכתוב את הקישור לקובץ לוג ולהעתיק ידנית, קוראים לשירות
והוא שולח את ההודעה בעצמו.

## הקריאה

</div>

```
POST https://signal-broadcast-658282975646.europe-west1.run.app/api/broadcast
Content-Type: application/json

{
  "document_id": "I7iP9eviU22W6X3fuXhC",
  "provider_id": "hamal_behirot"
}
```

<div dir="rtl">

### שדות

| שדה | חובה? | הסבר |
|---|---|---|
| `document_id` | כן | מזהה המסמך ב-`social-reactions` — אותו מזהה שכבר נכנס היום לקישור של יוריקי לייט |
| `provider_id` | כן* | מזהה ספק התוכן — ה-doc id בטבלת `content_providers` (למשל `hamal_behirot`) |
| `channel_id` | כן* | חלופה ל-`provider_id`: מזהה ערוץ ה-Slack ששמור על מסמך הספק (למשל `C0AQN7L62EB`) |
| `post_text` | לא | טקסט לתקציר בהודעה; אם לא נשלח — נלקח `postDescription` מהמסמך |

\* צריך לשלוח אחד מהשניים — מה שנוח לכם. אם יש לכם רק את מזהה ערוץ ה-Slack, זה מספיק.

### תשובה מוצלחת

</div>

```json
{ "ok": true, "flow": "group", "signalGroupId": "...", "requestId": "..." }
```

<div dir="rtl">

## אימות (Authentication)

השירות סגור — מקבל רק קריאות עם Google identity token. שני צעדים:

1. שלחו לנו את כתובת ה-service account שהקוד שלכם רץ איתו (למשל
   `xxx@torino-social.iam.gserviceaccount.com`) — נעניק לו הרשאת `roles/run.invoker`.
2. בקוד, מוסיפים לבקשה כותרת `Authorization: Bearer <ID_TOKEN>` כשה-audience הוא
   כתובת השירות. מתוך סביבת GCP (Cloud Run / Functions / GCE) משיגים את הטוקן כך:

</div>

```
GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https://signal-broadcast-658282975646.europe-west1.run.app
Header: Metadata-Flavor: Google
```

<div dir="rtl">

(ב-Node אפשר פשוט עם החבילה `google-auth-library`:
`new GoogleAuth().getIdTokenClient(url)` — והיא מטפלת בהכול.)

## מה צריך להיות מוגדר כדי שההודעה באמת תישלח

על מסמך הספק ב-`content_providers` צריך להיות לפחות יעד אחד — Signal, וואטסאפ, או שניהם.
ההודעה נשלחת לשתי הפלטפורמות מאותה קריאה אחת.

**Signal** — שדה `signal_group_id` (מזהה קבוצת הסיגנל). מגדירים פעם אחת לכל ערוץ:

1. מוסיפים את מספר הבוט **‎+972 55-9761823** (מופיע בתור "Yoriki") כחבר בקבוצת ה-Signal.
2. אנחנו שולפים את מזהה הקבוצה ורושמים אותו על מסמך הספק.

**וואטסאפ** — שדה `whatsapp_group_id` (מזהה בפורמט `120363412662305778@g.us`).
השליחה מתבצעת דרך פלטפורמת Beacon:

1. מוסיפים את מספר הוואטסאפ של Beacon **‎+972 52-434-2846** כחבר בקבוצת הוואטסאפ.
2. אנחנו שולפים את מזהה הקבוצה מ-Beacon ורושמים אותו על מסמך הספק.

**כמה קבוצות עם סינון לפי רשת** — במקום שדה בודד אפשר `signal_targets` /
`whatsapp_targets`, מערך שבו כל יעד יכול להיות מוגבל לרשתות מסוימות:

</div>

```json
[
  { "group_id": "…" },
  { "group_id": "…", "networks": ["x"] },
  { "group_id": "…", "networks": ["facebook", "instagram"] }
]
```

<div dir="rtl">

הרשת נקבעת לפי שדה `socialMedia` של מסמך הפוסט. יעד בלי סינון מקבל הכול.

ספק בלי אף יעד יקבל שגיאת 409 עם הסבר. כשל בשליחה לוואטסאפ **אינו** מפיל את
השידור — הסיגנל כבר נשלח, והתשובה תכלול שדה `whatsappError`.

## שגיאות נפוצות

| קוד | משמעות |
|---|---|
| 400 | חסר `document_id` או מזהה ספק |
| 401/403 | בעיית אימות — ה-service account לא קיבל הרשאה או שהטוקן לא תקין |
| 404 | ספק לא נמצא ב-`content_providers` |
| 409 | לספק אין `signal_group_id` (או: אין משתמשים רשומים במסלול ציד-פייקים) |

לכל תשובה מצורף `requestId` — צרפו אותו כשמדווחים על בעיה.

</div>
