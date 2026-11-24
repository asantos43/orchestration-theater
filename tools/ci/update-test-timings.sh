#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# uso: tools/ci/update-test-timings.sh <run-id>
# Rewrites tools/ci/test-timings.json (the durations that balance the shards of the tests,
# tools/ci/src/duration-shard.ts) from the logs of the jobs `linux-tests`, `cross (macos-latest, ...)`
# and `cross (windows-latest, ...)` of a run of the CI. Best from a run of the whole suite (a push to
# main, a dispatch, or a PR that touches a global file): a run of affected tests measures fewer
# files, and the others keep their old values. Needs `gh` signed in, and the build of tools/ci.
# Run it by hand and commit the result; the CI never runs it.
set -euo pipefail
run=${1:?uso: tools/ci/update-test-timings.sh <run-id>}
repo=${OT_TIMINGS_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
jobs=$(timeout 60 gh run view "$run" -R "$repo" --json jobs \
  --jq '.jobs[] | select(.conclusion == "success" or .conclusion == "failure") | "\(.databaseId)\t\(.name)"')
for pair in 'linux:^linux-tests' 'darwin:^cross [(]macos-latest' 'win32:^cross [(]windows-latest'; do
  platform=${pair%%:*}
  logs=()
  while IFS=$'\t' read -r id name; do
    [ -n "$id" ] || continue
    timeout 120 gh api --allow-escape-sequences "repos/$repo/actions/jobs/$id/logs" |
      sed 's/\x1b\[[0-9;]*m//g; s/^[0-9TZ:.-]* //' > "$dir/$id.log"
    logs+=("$dir/$id.log")
  done < <(printf '%s\n' "$jobs" | awk -F'\t' -v re="${pair#*:}" '$2 ~ re')
  if [ ${#logs[@]} -eq 0 ]; then
    echo "update-test-timings: no job of $platform in run $run"
    continue
  fi
  node tools/ci/dist/test-timings-cli.js --platform "$platform" "${logs[@]}"
done
