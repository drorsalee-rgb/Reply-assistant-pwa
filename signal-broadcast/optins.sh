#!/bin/sh
# Who is registered for Fake Hunting alerts, and what they asked for.
# Reads the fake-hunt-optins collection, and counts how many alerts each
# person has been sent (from fake-hunt-selections).
#
# Usage: ./optins.sh
# Requires: gcloud logged in with access to the torino-social project.
set -e
PROJECT=torino-social
ACCOUNT=${GCLOUD_ACCOUNT:-saleeclaude@gmail.com}
TOKEN=$(gcloud auth print-access-token --account="$ACCOUNT")
BASE="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents"

OPTINS=$(curl -s "$BASE/fake-hunt-optins?pageSize=300" -H "Authorization: Bearer $TOKEN")
SENT=$(curl -s "$BASE/fake-hunt-selections?pageSize=1000" -H "Authorization: Bearer $TOKEN")

printf '%s\n---SPLIT---\n%s\n' "$OPTINS" "$SENT" | python3 "$(dirname "$0")/optins.py"
