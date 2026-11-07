#!/usr/bin/env bash
# CI only: puts into .fdash/cache the fdash records that main's latest finished run published as the artifact
# named $1 (fdash-static, fdash-e2e-<shard>). Only runs of a push to main publish records, so a pull request
# cannot add one (.github/workflows/ci.yml, decision 0035). Without such an artifact, nothing is restored and
# every check runs. Needs GH_TOKEN with actions: read.
set -u
name=$1
mkdir -p .fdash/cache
ids=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch main --event push --status completed \
  --limit 5 --json databaseId --jq '.[].databaseId' 2>/dev/null || true)
for id in $ids; do
  if gh run download "$id" --repo "$GITHUB_REPOSITORY" --name "$name" --dir .fdash/cache >/dev/null 2>&1; then
    echo "records from main's run $id: $(find .fdash/cache -type f | wc -l)"
    exit 0
  fi
done
echo "no records from main: every check runs"
