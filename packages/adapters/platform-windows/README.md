# @otheater/adapter-platform-windows

`WindowsProcessLauncher`, the adapter of the `ProcessLauncher` port of `@otheater/core` (id `windows`, Windows). It provides the process tree under a Job Object, through the `ot-job-launcher` executable, and the resolution of npm shims.

- **Conformance:** describeProcessLauncherConformance.
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
