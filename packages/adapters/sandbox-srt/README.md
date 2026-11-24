# @otheater/adapter-sandbox-srt

`SrtSandbox`, the adapter of the `Sandbox` port of `@otheater/core` (id `srt`, layer 3 of the permissions (architecture 5.8)). It provides the sandbox of the executors, over `sandbox-runtime` (macOS and Linux).

- **Conformance:** no conformance suite yet (`Sandbox` is listed as "complete" in the review of the ports, docs/23).
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
