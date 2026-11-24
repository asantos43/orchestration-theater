# @otheater/adapter-vault-keyring

`KeyringVault`, the adapter of the `SecretVault` port of `@otheater/core` (id `keyring`, `adapters.vault: keyring`). It provides the secrets in the keyring of the operating system.

- **Conformance:** describeSecretVaultConformance (on an in-memory backend: the tests never touch the real keyring).
- **Guide:** how an adapter is written, tested and mounted in `compose.ts` (the three things of every port, the dependency rule, typed errors, the port version) is in [docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](../../../docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **Architecture:** section 5.18 of [arquitetura.md](../../../docs/framework-ideas/arquitetura.md).
