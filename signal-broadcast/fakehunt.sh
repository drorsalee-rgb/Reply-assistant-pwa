#!/bin/sh
# Fake Hunting report: who is registered, and who opened / acted on each alert.
#
# Usage: ./fakehunt.sh
# Requires: gcloud logged in with access to the torino-social project.
set -e
PROJECT=torino-social
ACCOUNT=${GCLOUD_ACCOUNT:-saleeclaude@gmail.com}
TOKEN=$(gcloud auth print-access-token --account="$ACCOUNT")
BASE="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents"

q(){ # $1 = JSON structuredQuery body
  curl -s -X POST "${BASE}:runQuery" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "$1"
}

OPTINS=$(curl -s "$BASE/fake-hunt-optins?pageSize=300" -H "Authorization: Bearer $TOKEN")
SELECTIONS=$(q '{"structuredQuery":{"from":[{"collectionId":"fake-hunt-selections"}],"orderBy":[{"field":{"fieldPath":"selectedAt"},"direction":"DESCENDING"}],"limit":500}}')
STATS=$(curl -s "$BASE/pwa-stats?pageSize=300" -H "Authorization: Bearer $TOKEN")
# Per-recipient opens live in a "recipients" subcollection under each stats
# doc; a collection-group query gathers them in one request.
OPENS=$(q '{"structuredQuery":{"from":[{"collectionId":"recipients","allDescendants":true}],"limit":1000}}')

printf '%s\n---SPLIT---\n%s\n---SPLIT---\n%s\n---SPLIT---\n%s\n' \
  "$OPTINS" "$SELECTIONS" "$STATS" "$OPENS" | python3 "$(dirname "$0")/fakehunt.py"
