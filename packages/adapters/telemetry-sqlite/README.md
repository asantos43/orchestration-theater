# @otheater/adapter-telemetry-sqlite

`SqliteTelemetryStore`, the adapter of the `TelemetryStore` port of `@otheater/core` (id `sqlite`, the telemetry base, a file apart from the store (N54)). It provides the storage of the telemetry of the clients in SQLite.

- **Conformance:** no conformance suite yet (`TelemetryStore` is listed as "complete" in the review of the ports, docs/23).
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
