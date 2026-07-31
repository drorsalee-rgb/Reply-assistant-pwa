"""Formats the usage report. Reads two JSON blobs (broadcast-log, pwa-stats)
separated by a marker line on stdin; called by stats.sh."""
import sys, json
from datetime import datetime, timezone, timedelta

try:
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo('Asia/Jerusalem')
except Exception:                       # no tz database available
    LOCAL_TZ = timezone(timedelta(hours=3))


def to_local(ts):
    """'2026-07-31T11:41:40.123Z' (UTC) -> '2026-07-31 14:41' (Israel)."""
    if not ts:
        return ''
    dt = datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ).strftime('%Y-%m-%d %H:%M')

# When the service started counting distinct people per press (UTC).
PEOPLE_COUNTING_FROM = '2026-07-31 14:34'

raw = sys.stdin.read().split('---SPLIT---')
broadcasts = json.loads(raw[0])
stats_docs = json.loads(raw[1]).get('documents', [])


def scalar(field):
    (kind, value), = field.items()
    return int(value) if kind == 'integerValue' else value


stats = {}
for d in stats_docs:
    stats[d['name'].split('/')[-1]] = {k: scalar(v) for k, v in d.get('fields', {}).items()}

header = (f"{'when (IL)':<17}{'channel':<20}{'people':>7}{'pressed':>8}"
          f"{'rate':>7}  {'opens':>6}{'presses':>8}{'style':>7}{'declines':>9}")
print(header)
print('-' * len(header))

for row in broadcasts:
    doc = row.get('document')
    if not doc:
        continue
    f = doc['fields']
    doc_id = f.get('documentId', {}).get('stringValue', '')
    when_utc = f.get('at', {}).get('timestampValue', '')[:16].replace('T', ' ')
    when = to_local(f.get('at', {}).get('timestampValue', ''))
    channel = f.get('providerId', {}).get('stringValue', '')[:19]
    s = stats.get(doc_id, {})
    people = s.get('uniqueOpens', 0)
    raw_presses = s.get('copyOpen', 0)
    unique_presses = s.get('uniqueCopyOpen', 0)

    # Per-person press counting only started at PEOPLE_COUNTING_FROM. Posts
    # broadcast before then have, at best, partial per-person data (only the
    # stragglers who pressed later), so show their raw press count flagged
    # with '*' rather than a number that looks precise and isn't.
    if when_utc >= PEOPLE_COUNTING_FROM:
        pressed, flag = unique_presses, ''
    else:
        pressed, flag = raw_presses, '*'

    rate = f'{min(pressed / people * 100, 999):.0f}%{flag}' if people else '-'
    print(f"{when:<17}{channel:<20}{people:>7}{str(pressed) + flag:>8}{rate:>7}  "
          f"{s.get('opens', 0):>6}{raw_presses:>8}"
          f"{s.get('styleSelected', 0):>7}{s.get('declines', 0):>9}")

print()
print('people  = distinct people who opened the post    pressed = distinct people who pressed העתק ופתח')
print('rate    = pressed / people — the conversion that matters')
print('opens / presses = raw totals, including repeat visits and repeat presses by the same person')
print('*       = per-person press counting started 31/07 17:34 (IL); older rows show raw presses,')
print('          so the same person pressing twice inflates them (rate can exceed 100%).')
print('Recipient count is unknown — messages are also forwarded to WhatsApp manually.')
