"""Formats the Fake Hunting registration list; called by optins.sh."""
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

raw = sys.stdin.read().split('---SPLIT---')
optins = json.loads(raw[0]).get('documents', [])
sent = json.loads(raw[1]).get('documents', [])

counts = {}
for d in sent:
    phone = d.get('fields', {}).get('phone', {}).get('stringValue')
    if phone:
        counts[phone] = counts.get(phone, 0) + 1

header = f"{'name':<12}{'phone':<18}{'networks':<40}{'joined (IL)':<18}{'alerts':>7}"
print(header)
print('-' * len(header))

active = 0
for d in sorted(optins, key=lambda x: x.get('createTime', '')):
    f = d.get('fields', {})
    phone = f.get('phone', {}).get('stringValue', d['name'].split('/')[-1])
    on = f.get('active', {}).get('booleanValue', False)
    nets = [v['stringValue'] for v in f.get('networks', {}).get('arrayValue', {}).get('values', [])]
    # No list recorded means the default set, not "literally everything".
    label = ', '.join(nets) if nets else 'default (' + ', '.join(DEFAULT) + ')'
    if not on:
        label = 'STOPPED'
    else:
        active += 1
    name = f.get('firstName', {}).get('stringValue', '')[:11] or '-'
    print(f"{name:<12}{phone:<18}{label:<40}"
          f"{local(f.get('joinedAt', {}).get('timestampValue', '')):<18}{counts.get(phone, 0):>7}")

print()
print(f"{active} active of {len(optins)} registered.")
print("alerts = how many Fake Hunting alerts this person has been sent (all time).")
