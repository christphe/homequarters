#!/usr/bin/env bash
# The gauntlet's gates now live in fdash.json and run through scripts/gauntlet.ts (usage there); this
# wrapper keeps the old command working.
exec node "$(dirname "$0")/gauntlet.ts" "$@"
