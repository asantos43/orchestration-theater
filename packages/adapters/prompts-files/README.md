# @otheater/adapter-prompts-files

`FilePromptSource`, the adapter of the `PromptSource` port of `@otheater/core` (id `files`, `adapters.prompts: files`). It provides the role prompts, one `<role>.md` per role, from the versioned `prompts/` folder or a configured one.

- **Conformance:** describePromptSourceConformance.
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
