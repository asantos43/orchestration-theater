#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Runs one shard of the chaos suite (`pnpm test:chaos`) for a job of the matrix of chaos.yml
# (CI under 10 min, owner, 2026-11-24).
#
#   tools/ci/chaos-shard.sh <index>/<count>
#
# The suite has two kinds of files:
# - the long ones, which split their own cases (the named points and the random instants) with the
#   `ChaosSlicer` of packages/daemon/src/chaos/harness.ts: every shard runs all of them, each with
#   OT_CHAOS_SHARD=<index>/<count>, and keeps its part of the cases;
# - the others, whole files that vitest spreads among the shards (`--shard`).
# A long file is one that names `ChaosSlicer`, found by `git grep`: a new file that uses it joins
# the first kind on its own. The `count` shards together run every case of the suite once, with the
# same seeds as a run without shards (OT_CHAOS_SEED repeats a failure in any of them).
# OT_CHAOS_DRY=1 prints the two lists instead of running them.
set -euo pipefail

shard="${1:?usage: tools/ci/chaos-shard.sh <index>/<count>}"
if ! [[ "$shard" =~ ^([0-9]+)/([0-9]+)$ ]] || [ "${BASH_REMATCH[1]}" -lt 1 ] \
  || [ "${BASH_REMATCH[1]}" -gt "${BASH_REMATCH[2]}" ]; then
  echo "chaos-shard: $shard: use <index>/<count>, with 1 <= index <= count" >&2
  exit 1
fi

sliced=$(git grep -l 'ChaosSlicer' -- '*.chaos.test.ts' | sort)
whole=$(git ls-files -- '*.chaos.test.ts' | grep -vxF -f <(printf '%s\n' "$sliced") | sort || true)
echo "chaos-shard $shard: split inside: $(printf '%s' "$sliced" | grep -c . || true) file(s); whole: $(printf '%s' "$whole" | grep -c . || true) file(s)"
if [ "${OT_CHAOS_DRY:-}" = 1 ]; then
  printf 'split: %s\n' $sliced
  printf 'whole: %s\n' $whole
  exit 0
fi

status=0
if [ -n "$whole" ]; then
  # shellcheck disable=SC2086 # one path per word; the test paths have no spaces.
  pnpm exec vitest run -c vitest.chaos.config.ts --shard="$shard" --passWithNoTests $whole || status=$?
fi
if [ -n "$sliced" ]; then
  # shellcheck disable=SC2086
  OT_CHAOS_SHARD="$shard" pnpm exec vitest run -c vitest.chaos.config.ts $sliced || status=$?
fi
exit "$status"
