# @otheater/example-adapter-clock

The smallest complete adapter of OTheater: a `Clock` (wall-clock time and real timers) with the conformance suite of the port. It is a teaching copy of `SystemClock` (`packages/adapters/clock-system`), kept short on purpose.

| File | What it shows |
| --- | --- |
| `src/index.ts` | the identity (`Adapter`: id, port and range of the port version) and the strict configuration schema |
| `src/clock.ts` | the implementation, with the typed errors of the contract (`InvalidInput`, `Cancelled`) |
| `src/clock.test.ts` | the conformance suite of the port, plus the tests of what is only this adapter's |
| `src/guide.test.ts` | checks that the code quoted in the guide is this code |

The walk-through is [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md). The package is `private` and is not mounted by the daemon: it only exists to be read and to run in the CI. Run it with `pnpm exec vitest run --maxWorkers=2 examples/adapter-clock`.
