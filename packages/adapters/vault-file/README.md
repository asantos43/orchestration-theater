# @otheater/adapter-vault-file

`EncryptedFileVault`, the adapter of the `SecretVault` port of `@otheater/core` (id `encrypted-file`, `adapters.vault: encrypted-file`). It provides the secrets in a file encrypted with a master password.

- **Conformance:** describeSecretVaultConformance.
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
