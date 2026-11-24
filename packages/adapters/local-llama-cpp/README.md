# @otheater/adapter-local-llama-cpp

`LlamaCppServer`, the adapter of the `LocalModelServer` port of `@otheater/core` (id `llama-cpp`, the `llama-server` of llama.cpp). It provides health, loaded models and slots of a local `llama-server`, over HTTP (stateless: the URL comes with each call).

- **Conformance:** describeLocalModelServerConformance.
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
