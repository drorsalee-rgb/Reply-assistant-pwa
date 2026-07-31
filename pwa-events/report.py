"""Formats the usage report. Reads two JSON blobs (broadcast-log, pwa-stats)
separated by a marker line on stdin; called by stats.sh."""
import sys, json

raw = sys.stdin.read().split('---SPLIT---')
broadcasts = json.loads(raw[0])
stats_docs = json.loads(raw[1]).get('documents', [])


def scalar(field):
    (kind, value), = field.items()
    return int(value) if kind == 'integerValue' else value


stats = {}
for d in stats_docs:
    stats[d['name'].split('/')[-1]] = {k: scalar(v) for k, v in d.get('fields', {}).items()}

header = (f"{'when':<17}{'channel':<20}{'people':>7}{'pressed':>8}"
          f"{'rate':>6}   {'opens':>6}{'presses':>8}{'style':>7}{'declines':>9}")
print(header)
print('-' * len(header))

for row in broadcasts:
    doc = row.get('document')
    if not doc:
        continue
    f = doc['fields']
    doc_id = f.get('documentId', {}).get('stringValue', '')
    when = f.get('at', {}).get('timestampValue', '')[:16].replace('T', ' ')
    channel = f.get('providerId', {}).get('stringValue', '')[:19]
    s = stats.get(doc_id, {})
    people = s.get('uniqueOpens', 0)
    pressed = s.get('uniqueCopyOpen', 0)
    rate = f'{pressed / people * 100:.0f}%' if people else '-'
    print(f"{when:<17}{channel:<20}{people:>7}{pressed:>8}{rate:>6}   "
          f"{s.get('opens', 0):>6}{s.get('copyOpen', 0):>8}"
          f"{s.get('styleSelected', 0):>7}{s.get('declines', 0):>9}")

print()
print('people  = distinct people who opened the post    pressed = distinct people who pressed העתק ופתח')
print('rate    = pressed / people — the conversion that matters')
print('opens / presses = raw totals, including repeat visits and repeat presses by the same person')
print('Recipient count is unknown — messages are also forwarded to WhatsApp manually.')
