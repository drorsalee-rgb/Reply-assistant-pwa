#!/bin/sh
# Syncs the static site files into public/ (Firebase Hosting's serve root,
# kept separate from the repo root so .git and other project files are
# never exposed publicly) and deploys to Firebase Hosting.
set -e
cd "$(dirname "$0")"

mkdir -p public/icons
cp index.html manifest.json service-worker.js public/
cp icons/icon-192.png icons/icon-512.png public/icons/

firebase deploy --only hosting
