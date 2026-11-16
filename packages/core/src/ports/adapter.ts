// SPDX-License-Identifier: MPL-2.0

/** Which port an adapter implements and which semver range of that port's contract it accepts. */
export interface AdapterImplements {
  /** Port name as exported by `@otheater/core`, e.g. `'Store'`, `'SecretVault'`, `'Clock'`. */
  readonly port: string;
  /** Semver range of the port contract, e.g. `'^0.1.0'` (compared with `STORE_PORT_VERSION`...). */
  readonly range: string;
}

/**
 * Identity every adapter declares (architecture 5.18, "Versão dos contratos"). At start-up the
 * composition point refuses an adapter whose `implements.range` does not cover the port version,
 * naming the port, the expected version and the one received. The range check itself lives in the
 * daemon: core stays free of a semver dependency.
 */
export interface Adapter {
  /** Stable id used in the configuration and shown in Settings: `'sqlite'`, `'keyring'`... */
  readonly id: string;
  readonly implements: AdapterImplements;
}
