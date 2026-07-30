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

printf '%s\n---SPLIT---\n%s\n' "$BROADCASTS" "$STATS" | python3 "$(dirname "$0")/report.py"
