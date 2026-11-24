# @otheater/adapter-clock-system

`SystemClock`, the adapter of the `Clock` port of `@otheater/core` (id `system`, `adapters.clock: system`). It provides wall-clock time (never going backwards) and real timers, with waits above 2^31-1 ms split in slices.

- **Conformance:** describeClockConformance (the real clock and a real-time test clock).
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).

The example `examples/adapter-clock` is a short copy of this adapter.
