# ATIF fixtures (third-party copies)

Two trajectories copied from the Harbor project (`harbor-framework/harbor`, Apache-2.0), used by
`../schema.test.ts` to check that the zod schema accepts what other producers write. The license
text is in `LICENSE-harbor.txt` (copied from the repository root at the commit below). Harbor has no
`NOTICE` file and its `LICENSE` has no copyright line. Both are listed in `tools/verify/copied-code.json`.

| File | Origin (read on 2026-11-21) | Commit that last touched the origin file |
| --- | --- | --- |
| `rfc-0001-stock-price.json` | `rfcs/0001-trajectory-format.md`, section IV (the example JSON block, ATIF-v1.5) | `74cc6312018c349c6bd2400c89a0ac4983ac1085` |
| `harbor-hello-claude-code.json` | `examples/tasks/hello-load-atif-trajectory-run-level/environment/trajectory.json` (ATIF-v1.7) | `646874a7bfc23c45228f6d25bc900eac5ddc4541` |

Changes from the origin: only the formatting (Prettier). No data was added or removed. They carry no
personal data (the paths are those of a container, `/app`).
