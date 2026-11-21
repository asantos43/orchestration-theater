#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Runs the vitest tests a change can affect, instead of the whole suite (owner, 2026-11-21).
#
#   tools/ci/test-affected.sh <base-ref>
#
# OT_TEST_CI picks the mode: `affected` (default) or `full` (always `vitest run`).
#
# In `affected`, the changed files are those of `git diff <base-ref>` (the working tree against the
# base). The whole suite still runs when one of them is "global", that is, reaches tests that the
# module graph of vitest does not see:
# - the lockfile, the workspace, any package.json or tsconfig, the vitest config, this script and
#   .github/ (the dependencies, the build and the CI itself);
# - packages/protocol/src and packages/core/src (almost every test imports them);
# - locales/, prompts/, native/ and docs/reference/ (read as files by tests and by the daemon);
# - any file under packages/ or tools/ that is not .ts, .tsx or .md (fixtures, catalogs, patches).
# Otherwise it runs, in one `vitest run`, the union of:
# - the tests `vitest list --changed <base-ref>` finds through the module graph (the aliases of
#   vitest.config.ts send every @otheater/* import to its sources, so the graph crosses packages);
# - the tests that run the build output (they name a dist/ path): the graph stops at the sources,
#   so a change to any source can change what they run. The list comes from `git grep`, so a new
#   test of that kind enters it on its own.
# With nothing to run it prints so and exits 0. OT_TEST_DRY=1 prints the decision and the files
# instead of running them.
set -euo pipefail

base="${1:?usage: tools/ci/test-affected.sh <base-ref>}"
mode="${OT_TEST_CI:-affected}"

full() {
  echo "test-affected: full suite ($1)"
  if [ "${OT_TEST_DRY:-}" = 1 ]; then exit 0; fi
  exec pnpm exec vitest run
}

case "$mode" in
  affected) ;;
  full) full "OT_TEST_CI=full" ;;
  *)
    echo "test-affected: OT_TEST_CI=$mode: use affected or full" >&2
    exit 1
    ;;
esac

changed=$(git diff --name-only "$base")
printf 'test-affected: %s changed file(s) since %s\n' "$(printf '%s' "$changed" | grep -c . || true)" "$base"

global=$(printf '%s\n' "$changed" | grep -E \
  '^(pnpm-lock\.yaml|pnpm-workspace\.yaml|vitest\.config\.[^/]+|tools/ci/test-affected\.sh)$|(^|/)package\.json$|(^|/)tsconfig[^/]*\.json$|^\.github/|^packages/(protocol|core)/src/|^(locales|prompts|native|docs/reference)/' \
  || true)
other=$(printf '%s\n' "$changed" | grep -E '^(packages|tools)/' | grep -vE '\.(ts|tsx|md)$' || true)
trigger=$(printf '%s\n%s\n' "$global" "$other" | grep . | head -n 1 || true)
if [ -n "$trigger" ]; then
  full "global file: $trigger"
fi

graph=$(pnpm exec vitest list --changed "$base" --filesOnly | sed -nE 's/^\[[^]]*\] //p')
dist=$(git grep -lE "['\"/]dist/" -- '*.test.ts' '*.test.tsx' || true)
files=$(printf '%s\n%s\n' "$graph" "$dist" | grep . | sort -u || true)
count=$(printf '%s' "$files" | grep -c . || true)

if [ "$count" -eq 0 ]; then
  echo "test-affected: no test to run"
  exit 0
fi
# A long list of positional filters can pass the command-line limit of Windows (32 KiB); past this
# many files the run is close to the whole suite anyway.
if [ "$count" -gt 250 ]; then
  full "$count affected test files"
fi

echo "test-affected: $count test file(s) (graph and dist/)"
if [ "${OT_TEST_DRY:-}" = 1 ]; then
  printf '%s\n' "$files"
  exit 0
fi
# shellcheck disable=SC2086 # one path per word; the test paths have no spaces.
exec pnpm exec vitest run $files
