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
# base) and the untracked ones. The whole suite still runs when one of them is "global", that is,
# reaches tests that the module graph of vitest does not see:
# - the lockfile, the workspace, any package.json or tsconfig, the vitest config, this script and
#   .github/ (the dependencies, the build and the CI itself);
# - packages/protocol/src and packages/core/src (almost every test imports them);
# - locales/, prompts/, native/ and docs/reference/ (read as files by tests and by the daemon);
# - any file under packages/ or tools/ that is not .ts, .tsx or .md (fixtures, catalogs, patches),
#   except tools/atif-validate/ (the Python validator of ATIF, which no vitest test reads: it has its
#   own job in the CI, `atif`).
# Otherwise it runs, in one `vitest run`, the union of:
# - the tests `vitest list --changed <base-ref>` finds through the module graph (the aliases of
#   vitest.config.ts send every @otheater/* import to its sources, so the graph crosses packages);
# - the tests that run the build output (they name a dist/ path): the graph stops at the sources,
#   so a change to any source can change what they run. The list comes from `git grep`, so a new
#   test of that kind enters it on its own. The chaos tests (`*.chaos.test.ts`, `pnpm test:chaos`,
#   workflow chaos.yml) are not in the suite and stay out of the list.
# With nothing to run it prints so and exits 0. OT_TEST_DRY=1 prints the decision and the files
# instead of running them.
#
# OT_CROSS_TESTS picks which of those tests run (owner, 2026-11-22, N162): unset or `all` (all of
# them, what the job `linux` does) or `os` (the job `cross`, macOS and Windows, on a pull request:
# only the tests that touch the system, chosen by tools/ci/src/cross-classify.ts, built to
# tools/ci/dist). The filter applies to the final list, the affected files or the whole suite alike.
# If the classifier fails the list stays as it was (an error never runs less), with a warning.
# OT_CROSS_CLASSIFIER names another classifier (a test hook; the default is tools/ci/dist/cross-classify-cli.js).
set -euo pipefail

base="${1:?usage: tools/ci/test-affected.sh <base-ref>}"
mode="${OT_TEST_CI:-affected}"
cross="${OT_CROSS_TESTS:-all}"

case "$cross" in
  all | os) ;;
  *)
    echo "test-affected: OT_CROSS_TESTS=$cross: use all or os" >&2
    exit 1
    ;;
esac

# Every test file of the suite, one per line, as `vitest list` prints them.
all_tests() {
  pnpm exec vitest list --filesOnly | sed -nE 's/^\[[^]]*\] //p'
}

# Runs the test files in $1 (one per line), after the filter of OT_CROSS_TESTS, or prints them when
# OT_TEST_DRY=1. $2 says where the list comes from.
run_files() {
  local files="$1" origin="$2" total count length selected
  total=$(printf '%s' "$files" | grep -c . || true)
  if [ "$cross" = os ]; then
    if selected=$(printf '%s\n' "$files" | node "${OT_CROSS_CLASSIFIER:-tools/ci/dist/cross-classify-cli.js}"); then
      files=$(printf '%s\n' "$selected" | grep . || true)
      echo "test-affected: OT_CROSS_TESTS=os: $(printf '%s' "$files" | grep -c . || true) of $total test file(s) touch the system"
    else
      echo "::warning::test-affected: the classifier failed: all $total test file(s) of the list run"
    fi
  fi
  count=$(printf '%s' "$files" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    echo "test-affected: no test to run"
    exit 0
  fi
  # A long list of positional filters can pass the command-line limit of Windows: 32 KiB for a
  # process, but 8191 characters through cmd.exe, which the `.cmd` shim of `pnpm exec` goes through.
  # So the files go to the entry point of vitest with `node` (no shim), and past this many files or
  # characters the run is close to the whole suite anyway. With OT_CROSS_TESTS=os the list is already
  # a part of the suite, so only the characters count.
  length=$(printf '%s' "$files" | wc -c | tr -d ' ')
  if [ "$length" -gt 24000 ] || { [ "$cross" != os ] && [ "$count" -gt 250 ]; }; then
    echo "test-affected: full suite ($count test files, $length characters)"
    if [ "${OT_TEST_DRY:-}" = 1 ]; then exit 0; fi
    exec pnpm exec vitest run
  fi
  echo "test-affected: $count test file(s) ($origin)"
  if [ "${OT_TEST_DRY:-}" = 1 ]; then
    printf '%s\n' "$files"
    exit 0
  fi
  # shellcheck disable=SC2086 # one path per word; the test paths have no spaces.
  exec node node_modules/vitest/vitest.mjs run $files
}

full() {
  echo "test-affected: full suite ($1)"
  # No list (vitest failed): no filter, never a run of nothing.
  if [ "$cross" = os ] && list=$(all_tests) && [ -n "$list" ]; then
    run_files "$list" "whole suite"
  fi
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

# Untracked files too, as `vitest --changed` sees them (none on a CI checkout).
changed=$(git diff --name-only "$base"; git ls-files --others --exclude-standard)
printf 'test-affected: %s changed file(s) since %s\n' "$(printf '%s' "$changed" | grep -c . || true)" "$base"

global=$(printf '%s\n' "$changed" | grep -E \
  '^(pnpm-lock\.yaml|pnpm-workspace\.yaml|vitest\.config\.[^/]+|tools/ci/test-affected\.sh)$|(^|/)package\.json$|(^|/)tsconfig[^/]*\.json$|^\.github/|^packages/(protocol|core)/src/|^(locales|prompts|native|docs/reference)/' \
  || true)
other=$(printf '%s\n' "$changed" | grep -E '^(packages|tools)/' | grep -vE '\.(ts|tsx|md)$|^tools/atif-validate/' || true)
trigger=$(printf '%s\n%s\n' "$global" "$other" | grep . | head -n 1 || true)
if [ -n "$trigger" ]; then
  full "global file: $trigger"
fi

graph=$(pnpm exec vitest list --changed "$base" --filesOnly | sed -nE 's/^\[[^]]*\] //p')
dist=$(git grep -lE "['\"/]dist/" -- '*.test.ts' '*.test.tsx' ':!*.chaos.test.ts' || true)
files=$(printf '%s\n%s\n' "$graph" "$dist" | grep . | sort -u || true)
run_files "$files" "graph and dist/"
