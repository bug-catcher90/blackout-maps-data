#!/usr/bin/env bash
# Copies the binary-format readers from the app repository into scripts/readers/.
#
#   scripts/sync-readers.sh [ref]     ref: branch, tag or commit of blackout-maps (default main)
#
# The validator and the build scripts read and write packages with these files,
# so they must match what the apps run. Run this whenever a format changes in
# bug-catcher90/blackout-maps (website/maps/), then re-validate and commit.
set -euo pipefail

ref="${1:-main}"
here="$(cd "$(dirname "$0")" && pwd)"
for name in places water addresses route buildings search; do
  curl -fsSL "https://raw.githubusercontent.com/bug-catcher90/blackout-maps/$ref/website/maps/$name.js" -o "$here/readers/$name.js"
done
commit="$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/bug-catcher90/blackout-maps/commits/$ref" || echo "$ref")"
echo "$commit" > "$here/readers/SOURCE"
echo "readers copied from bug-catcher90/blackout-maps@$commit"
