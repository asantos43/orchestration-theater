# @otheater/adapter-vcs-git

`GitVcs`, the adapter of the `Vcs` port of `@otheater/core` (id `git`, the version control of the plays). It provides worktree, branch, commit, merge and push over the `git` CLI.

- **Conformance:** describeVcsConformance.
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
