# SPDX-License-Identifier: MPL-2.0
"""Validates ATIF trajectory files with the TrajectoryValidator of Harbor (Phase 8, P6, N215).

    python -I atif_validate.py FILE [FILE ...]

Prints one JSON document on stdout:

    {"harbor": "0.25.0", "ok": false,
     "files": [{"path": "a.json", "valid": false, "errors": ["trajectory.steps.0: ..."]}]}

Exit code: 0 when every file passes, 1 when some file fails, 2 when the validator cannot run (no
arguments, or Harbor does not import). The errors are the ones the validator collects, unchanged.
"""

import json
import sys
from importlib import metadata


def main(argv: list[str]) -> int:
    paths = argv[1:]
    if not paths:
        print(json.dumps({"ok": False, "error": "usage: atif_validate.py FILE [FILE ...]"}))
        return 2
    try:
        from harbor.utils.trajectory_validator import TrajectoryValidator
    except Exception as error:  # a missing or broken install, whatever the cause
        print(json.dumps({"ok": False, "error": f"cannot import the Harbor validator: {error!r}"}))
        return 2

    files = []
    for path in paths:
        validator = TrajectoryValidator()
        valid = validator.validate(path)
        files.append({"path": path, "valid": valid, "errors": list(validator.get_errors())})
    report = {
        "harbor": metadata.version("harbor"),
        "ok": all(file["valid"] for file in files),
        "files": files,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
