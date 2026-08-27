"""Formats the Fake Hunting report; called by fakehunt.sh.

Reads four JSON blobs on stdin, separated by marker lines:
  fake-hunt-optins, fake-hunt-selections, pwa-stats, and the per-alert
  recipient subcollections.
"""
import sys, json
from datetime import datetime, timezone, timedelta

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo('Asia/Jerusalem')
except Exception:
    TZ = timezone(timedelta(hours=3))

DEFAULT = ['x', 'facebook', 'instagram', 'tiktok']


def local(ts):
    if not ts:
        return ''
    dt = datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
    return dt.astimezone(TZ).strftime('%Y-%m-%d %H:%M')


def val(field):
    if not field:
        return None
    (kind, v), = field.items()
    return int(v) if kind == 'integerValue' else v


raw = sys.stdin.read().split('---SPLIT---')
optins = json.loads(raw[0]).get('documents', [])
selections = [r['document'] for r in json.loads(raw[1]) if r.get('document')]
stats = {d['name'].split('/')[-1]: d.get('fields', {})
         for d in json.loads(raw[2]).get('documents', [])}
# per-recipient opens: { messageId: { slot: {opens, copyOpen} } }
opens = {}
for d in json.loads(raw[3]):
    doc = d.get('document')
    if not doc:
        continue
    parts = doc['name'].split('/')
    message = parts[-3].replace('debunk:', '')
    slot = parts[-1]
    f = doc.get('fields', {})
    opens.setdefault(message, {})[slot] = {
        'opens': val(f.get('opens')) or 0,
        'copyOpen': val(f.get('copyOpen')) or 0,
    }

# ---------- who is registered ----------
people = {}
for d in optins:
    f = d.get('fields', {})
    phone = val(f.get('phone')) or d['name'].split('/')[-1]
    nets = [v['stringValue'] for v in f.get('networks', {}).get('arrayValue', {}).get('values', [])]
    people[phone] = {
        'name': val(f.get('firstName')) or '-',
        'active': f.get('active', {}).get('booleanValue', False),
        'networks': ', '.join(nets) if nets else 'ברירת מחדל (' + ', '.join(DEFAULT) + ')',
        'joined': local(val(f.get('joinedAt'))),
        'sent': 0, 'opened': 0, 'copied': 0,
    }

# ---------- per-alert delivery, joined to opens ----------
alerts = {}
for d in selections:
    f = d.get('fields', {})
    message = val(f.get('messageId'))
    phone = val(f.get('phone'))
    if not message or not phone:
        continue
    slot = f.get('variant')
    slot = str(val(slot)) if slot and 'nullValue' not in slot else '0'
    acted = opens.get(message, {}).get(slot, {})
    row = {'phone': phone, 'opened': acted.get('opens', 0), 'copied': acted.get('copyOpen', 0),
           'at': local(val(f.get('selectedAt')))}
    # One slot belongs to one person per alert. Re-sends during testing left
    # several rows on the same slot; the selections came back newest-first, so
    # the first one seen is the one that counts.
    seen = alerts.setdefault(message, {})
    if slot in seen:
        continue
    seen[slot] = row
    if phone in people:
        people[phone]['sent'] += 1
        people[phone]['opened'] += 1 if row['opened'] else 0
        people[phone]['copied'] += 1 if row['copied'] else 0

# ---------- output ----------
print('=== מי רשום ===')
h = f"{'name':<12}{'phone':<18}{'networks':<44}{'joined':<18}{'sent':>5}{'opened':>7}{'replied':>8}"
print(h); print('-' * len(h))
for phone, p in sorted(people.items(), key=lambda kv: kv[1]['joined']):
    nets = 'STOPPED' if not p['active'] else p['networks']
    print(f"{p['name']:<12}{phone:<18}{nets:<44}{p['joined']:<18}"
          f"{p['sent']:>5}{p['opened']:>7}{p['copied']:>8}")
print()
print('sent = alerts sent to this person   opened = of those, how many they opened')
print('replied = of those, how many they pressed "העתק ופתח"')

print()
print('=== לפי התראה ===')
h2 = f"{'alert':<24}{'when':<18}{'sent':>5}{'opened':>7}{'replied':>8}   {'who opened'}"
print(h2); print('-' * len(h2))
for message, slots in sorted(alerts.items(),
                             key=lambda kv: max(r['at'] for r in kv[1].values()), reverse=True):
    rows = list(slots.values())
    who = [people.get(r['phone'], {}).get('name', r['phone']) or r['phone']
           for r in rows if r['opened']]
    s = stats.get('debunk:' + message, {})
    print(f"{message:<24}{max(r['at'] for r in rows):<18}{len(rows):>5}"
          f"{sum(1 for r in rows if r['opened']):>7}{sum(1 for r in rows if r['copied']):>8}"
          f"   {', '.join(who) if who else '-'}")
print()
print('Attribution comes from the variant slot in each recipient\'s link, so it only')
print('covers alerts sent after that was added — older rows show 0 opened.')
