#!/bin/sh
# Usage report: how many people opened each broadcast's PWA link and what
# they did there. Joins pwa-stats (counters) with broadcast-log (which
# channel each post was sent to).
#
# Usage: ./stats.sh [number of recent broadcasts, default 15]
# Requires: gcloud logged in with access to the torino-social project.
set -e
LIMIT=${1:-15}
PROJECT=torino-social
TOKEN=$(gcloud auth print-access-token)
BASE="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents"

fetch(){ # $1 = collection, $2 = limit, $3 = order field
  curl -s -X POST "$BASE:runQuery" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"structuredQuery\":{\"from\":[{\"collectionId\":\"$1\"}],\"orderBy\":[{\"field\":{\"fieldPath\":\"$3\"},\"direction\":\"DESCENDING\"}],\"limit\":$2}}"
}

BROADCASTS=$(fetch broadcast-log "$LIMIT" at)
STATS=$(curl -s "$BASE/pwa-stats?pageSize=300" -H "Authorization: Bearer $TOKEN")

printf '%s\n---SPLIT---\n%s\n' "$BROADCASTS" "$STATS" | python3 -c '
import sys, json
raw = sys.stdin.read().split("---SPLIT---")
broadcasts = json.loads(raw[0])
stats_docs = json.loads(raw[1]).get("documents", [])

def val(f):
    if not f: return None
    (k, v), = f.items()
    return int(v) if k == "integerValue" else v

stats = {}
for d in stats_docs:
    doc_id = d["name"].split("/")[-1]
    stats[doc_id] = {k: val({list(v.keys())[0]: list(v.values())[0]}) for k, v in d.get("fields", {}).items()}

hdr = f"{\"when\":<17}{\"channel\":<20}{\"opens\":>7}{\"uniq\":>6}{\"style\":>7}{\"copy\":>6}{\"decline\":>8}  rate"
print(hdr); print("-" * len(hdr))
for row in broadcasts:
    d = row.get("document")
    if not d: continue
    f = d["fields"]
    doc_id = f.get("documentId", {}).get("stringValue", "")
    when = f.get("at", {}).get("timestampValue", "")[:16].replace("T", " ")
    channel = f.get("providerId", {}).get("stringValue", "")[:19]
    s = stats.get(doc_id, {})
    uniq = s.get("uniqueOpens", 0) or 0
    copy = s.get("copyOpen", 0) or 0
    rate = f"{(copy / uniq * 100):.0f}%" if uniq else "-"
    print(f"{when:<17}{channel:<20}{s.get(\"opens\",0) or 0:>7}{uniq:>6}{s.get(\"styleSelected\",0) or 0:>7}{copy:>6}{s.get(\"declines\",0) or 0:>8}  {rate}")
print()
print("opens = link taps (incl. reloads) | uniq = distinct visits | copy = pressed העתק ופתח")
print("rate  = copy / uniq. Recipients are unknown (messages are forwarded to WhatsApp manually).")
'
