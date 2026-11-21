#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Validates the ATIF trajectories of OTheater with the TrajectoryValidator of Harbor (Phase 8, P6,
# N215). Run `pnpm build` first (the test plays the fake agent).
#
#   tools/atif-validate/run.sh [out-dir]
#
# 1. Creates a uv environment (tools/atif-validate/.venv, or OT_ATIF_VENV) with the pinned and
#    hashed requirements.txt: harbor and the pydantic it needs, without the other dependencies of
#    harbor (the heavy ones do not take part in the validator). If the validator does not import,
#    it falls back to the full install of harbor ONLY with OT_ATIF_HARBOR_FULL=1 (N215).
# 2. Runs packages/daemon/src/atif/atif-harbor.test.ts, which writes, into <out-dir>, `valid/`
#    (the three units of atif.export.unit in both contents) and `broken/` (defects on purpose).
# 3. Passes valid/ to the validator (all must pass) and each file of broken/ (each must fail).
#
# Outside GitHub Actions the script downloads nothing unless OT_TEST_HARBOR=1 (owner, 2026-11-21):
# without it, it says so and exits 0. In the CI the Python interpreter may be downloaded by uv; on
# a machine it is not (UV_PYTHON_DOWNLOADS=never): the machine needs a Python 3.13 (the one of the CI).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)

if [ "${GITHUB_ACTIONS:-}" != true ] && [ "${OT_TEST_HARBOR:-}" != 1 ]; then
  echo "atif-validate: skipped (it downloads the Harbor package: set OT_TEST_HARBOR=1)"
  exit 0
fi
command -v uv >/dev/null || { echo "atif-validate: uv is not installed" >&2; exit 1; }
if [ "${GITHUB_ACTIONS:-}" != true ]; then export UV_PYTHON_DOWNLOADS=never; fi

venv="${OT_ATIF_VENV:-$here/.venv}"
py="$venv/bin/python"
[ -x "$py" ] || uv venv --python 3.13 "$venv"

import_check() { "$py" -I -c 'from harbor.utils.trajectory_validator import TrajectoryValidator'; }

uv pip install --python "$py" --require-hashes --only-binary :all: --no-deps -r "$here/requirements.txt"
if ! import_check 2>/dev/null; then
  if [ "${OT_ATIF_HARBOR_FULL:-}" != 1 ]; then
    echo "atif-validate: the validator does not import without the dependencies of harbor;" >&2
    echo "atif-validate: set OT_ATIF_HARBOR_FULL=1 for the full install (heavy)" >&2
    exit 1
  fi
  version=$(sed -nE 's/^harbor==([0-9.]+).*/\1/p' "$here/requirements.txt")
  uv pip install --python "$py" --only-binary :all: "harbor==$version"
  import_check
fi

out="${1:-$(mktemp -d)}"
mkdir -p "$out"
rm -rf "$out/valid" "$out/broken"
echo "atif-validate: trajectories in $out"
(cd "$root" && OT_ATIF_OUT="$out" pnpm exec vitest run packages/daemon/src/atif/atif-harbor.test.ts)

mapfile -t valid < <(find "$out/valid" -name '*.json' | sort)
[ "${#valid[@]}" -gt 0 ] || { echo "atif-validate: no valid trajectory was written" >&2; exit 1; }
# One directory per unit and content: the six combinations must all be there.
for unit in play attempt play_files; do
  for content in full redacted; do
    [ -d "$out/valid/$unit-$content" ] || { echo "atif-validate: missing $unit-$content" >&2; exit 1; }
  done
done
echo "atif-validate: ${#valid[@]} trajectories that must pass"
"$py" -I "$here/atif_validate.py" "${valid[@]}" > "$out/report-valid.json" || {
  cat "$out/report-valid.json"
  echo "atif-validate: Harbor rejected a valid trajectory" >&2
  exit 1
}
"$py" -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("harbor", r["harbor"], "accepted", len(r["files"]), "files")' "$out/report-valid.json"

mapfile -t broken < <(find "$out/broken" -name '*.json' | sort)
[ "${#broken[@]}" -gt 0 ] || { echo "atif-validate: no broken trajectory was written" >&2; exit 1; }
for file in "${broken[@]}"; do
  status=0
  "$py" -I "$here/atif_validate.py" "$file" > "$out/report-broken.json" || status=$?
  if [ "$status" -ne 1 ]; then
    echo "atif-validate: $file: expected Harbor to reject it (exit 1), got exit $status" >&2
    cat "$out/report-broken.json" >&2
    exit 1
  fi
  "$py" -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["files"][0]; print("rejected", sys.argv[2], "->", r["errors"][0][:140])' "$out/report-broken.json" "$(basename "$file")"
done
echo "atif-validate: ok"
