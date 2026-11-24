# @otheater/adapter-platform-posix

`PosixProcessLauncher and PosixMemoryProbe`, the adapter of the `ProcessLauncher and MemoryProbe` port of `@otheater/core` (id `posix`, Linux and macOS (the memory probe also covers Windows through `os.freemem`)). It provides process groups, tree kill and the systemd scope for the launcher, and the free RAM for the admission.

- **Conformance:** describeProcessLauncherConformance (the launcher; the memory probe has no conformance suite yet).
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
