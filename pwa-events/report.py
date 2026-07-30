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

header = (f"{'when':<17}{'channel':<20}{'opens':>7}{'uniq':>6}"
          f"{'style':>7}{'copy':>6}{'decline':>8}  rate")
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
    opens = s.get('opens', 0)
    uniq = s.get('uniqueOpens', 0)
    copy = s.get('copyOpen', 0)
    rate = f'{copy / uniq * 100:.0f}%' if uniq else '-'
    print(f"{when:<17}{channel:<20}{opens:>7}{uniq:>6}"
          f"{s.get('styleSelected', 0):>7}{copy:>6}{s.get('declines', 0):>8}  {rate}")

print()
print('opens = link taps (incl. reloads) | uniq = distinct visits | copy = pressed העתק ופתח')
print('rate  = copy / uniq. Recipient count is unknown — messages are also forwarded to WhatsApp manually.')
