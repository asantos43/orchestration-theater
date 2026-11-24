# @otheater/adapter-codehost-github

`GithubCodeHost`, the adapter of the `CodeHost` port of `@otheater/core` (id `github`, the code host of the plays). It provides the pull request and delivery operations over the `gh` CLI, run as a child process.

- **Conformance:** describeCodeHostConformance (against the fake `CodeHost` and against `GithubCodeHost` with a fake `gh`).
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
