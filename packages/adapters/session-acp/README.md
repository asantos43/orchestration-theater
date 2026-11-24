# @otheater/adapter-session-acp

`AcpTransport`, the adapter of the `SessionTransport (the transport under `AgentSession`)` port of `@otheater/core` (id `acp`, the ACP connection of the clients). It provides ACP over the standard streams of the client process, one connection shared by the sessions on it.

- **Conformance:** describeAgentSessionConformance and describeClientAdapterConformance, in `acp-e2e.test.ts`, over the `fake-agent`.
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
