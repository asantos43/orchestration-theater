# @otheater/adapter-store-sqlite

`SqliteStore`, the adapter of the `Store and EventLog` port of `@otheater/core` (id `sqlite`, `adapters.store: sqlite`). It provides the persistence by aggregate, the transactions and the event log, in SQLite WAL, with two drivers (`better-sqlite3` and `node:sqlite`).

- **Conformance:** describeStoreConformance and describeEventLogConformance, run on both drivers.
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
