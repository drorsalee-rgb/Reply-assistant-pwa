#!/bin/sh
# Link a Signal group to a content provider, so /api/broadcast can route to it.
#
# Usage:
#   ./link-group.sh                                  — list all groups with their ids
#   ./link-group.sh "<signal group name>" <provider_id>  — link a group to a provider
# The name must match a SIGNAL group exactly, so take it from the no-argument
# listing above rather than typing it from memory — these are Signal groups,
# not the WhatsApp groups Beacon posts to, and the two sets have different
# names. Provider ids are the doc ids in content_providers (hamal_behirot,
# ze_bayadayim, white_rose, …).
#
# Prerequisites: the Yoriki bot (+972559761823) must already be a member of
# the group, and gcloud must be logged in as an account with access to the
# torino-social project (run: gcloud auth login).
set -e

GROUP_NAME="$1"
PROVIDER_ID="$2"

PROJECT=torino-social
ZONE=europe-west1-b
BOT=+972559761823

echo "Fetching the bot's group list from the signal-cli VM..."
GROUPS_JSON=$(gcloud compute ssh signal-cli --project "$PROJECT" --zone "$ZONE" --quiet \
  --command "curl -s -m 30 http://localhost:8080/v1/groups/$BOT" 2>/dev/null | tail -1)

# No arguments: just print every group with its id and exit.
if [ -z "$GROUP_NAME" ]; then
  printf '%s' "$GROUPS_JSON" | python3 -c "
import sys, json
for g in json.load(sys.stdin):
    print(f\"{g['name']}\n    id: {g['internal_id']}\")
"
  exit 0
fi

if [ -z "$PROVIDER_ID" ]; then
  echo "Usage: $0 [\"<signal group name>\" <provider_id>]" >&2
  exit 1
fi

GROUP_ID=$(printf '%s' "$GROUPS_JSON" | python3 -c "
import sys, json
name = '''$GROUP_NAME'''.strip()
groups = json.load(sys.stdin)
matches = [g for g in groups if g['name'].strip() == name]
if not matches:
    print('AVAILABLE GROUPS:', file=sys.stderr)
    for g in groups: print(' -', g['name'], file=sys.stderr)
    sys.exit(1)
print(matches[0]['internal_id'])
")

echo "Group id: $GROUP_ID"
echo "Writing signal_group_id to content_providers/$PROVIDER_ID ..."

TOKEN=$(gcloud auth print-access-token)
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents/content_providers/$PROVIDER_ID?updateMask.fieldPaths=signal_group_id" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"fields\":{\"signal_group_id\":{\"stringValue\":\"$GROUP_ID\"}}}")

if [ "$STATUS" = "200" ]; then
  echo "Linked: $PROVIDER_ID -> \"$GROUP_NAME\""
else
  echo "Failed (HTTP $STATUS). Does content_providers/$PROVIDER_ID exist?" >&2
  exit 1
fi
