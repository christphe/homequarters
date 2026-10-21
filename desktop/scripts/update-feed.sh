#!/usr/bin/env bash
# Writes latest.json for a desktop release (desktop-vX.Y.Z): each system's signed update file in that release,
# with its signature. Attaches it to the release, and to "desktop-latest" (the address installed apps read)
# when it is the newest desktop release, so rebuilding an older one never offers it as an update.
# Needs gh (GH_TOKEN, GH_REPO) and jq; run from the repository, with its tags.
set -euo pipefail
tag=${1:?usage: update-feed.sh desktop-vX.Y.Z}
work=$(mktemp -d)
cd "$work"

gh release download "$tag" --pattern '*.sig' 2>/dev/null || true # none before the updater key existed
assets=$(gh release view "$tag" --json assets --jq '.assets')
url() { echo "$assets" | jq -r --arg s "$1" '[.[] | select(.name | endswith($s)) | .url][0] // ""'; }
sig() { for f in *"$1"; do [ -e "$f" ] && tr -d '\n' < "$f"; done; }

jq -n \
  --arg v "${tag#desktop-v}" \
  --arg notes "$(gh release view "$tag" --json body --jq '.body')" \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg wurl "$(url _x64-setup.exe)" --arg wsig "$(sig _x64-setup.exe.sig)" \
  --arg murl "$(url .app.tar.gz)" --arg msig "$(sig .app.tar.gz.sig)" '
  {version: $v, notes: $notes, pub_date: $date, platforms: (
    (if $wurl != "" and $wsig != "" then {"windows-x86_64": {url: $wurl, signature: $wsig}} else {} end) +
    (if $murl != "" and $msig != "" then {"darwin-aarch64": {url: $murl, signature: $msig}} else {} end))}' > latest.json
cat latest.json

if [ "$(jq '.platforms | length' latest.json)" -eq 0 ]; then
  echo "::warning::no signed update files in $tag: no update feed"
  exit 0
fi
gh release upload "$tag" latest.json --clobber

newest=$(git -C "$OLDPWD" tag --list 'desktop-v*' --sort=-v:refname | head -1)
if [ "$tag" != "$newest" ]; then
  echo "$tag is not the newest desktop release ($newest): the update feed stays as it is"
  exit 0
fi
gh release view desktop-latest >/dev/null 2>&1 || gh release create desktop-latest --prerelease --latest=false \
  --title "Desktop update feed" \
  --notes "Where installed desktop apps look for updates (latest.json). Not a release: download the app from a desktop-vX.Y.Z release."
gh release upload desktop-latest latest.json --clobber
