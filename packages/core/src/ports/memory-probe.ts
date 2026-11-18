// SPDX-License-Identifier: MPL-2.0
import type { Adapter } from './adapter.js';

/** Semver of the `MemoryProbe` port contract (architecture 5.9, 5.18, "Versão dos contratos"). */
export const MEMORY_PROBE_PORT_VERSION = '0.1.0';

/**
 * Reads how much RAM the machine can still give to new processes (architecture 5.9, "Controle de
 * admissão"). The session pool asks it before it admits a session. [proposta] The port is not in the
 * table of 5.18 yet; it is the one the plan of Phase 5 (P4) asks for.
 *
 * Contract:
 * - `availableMb` never rejects. It resolves the memory a new process can take without swapping
 *   (`MemAvailable` of `/proc/meminfo` on Linux, in MB, rounded down), or `undefined` when this
 *   machine cannot tell. The caller decides what an unknown value means (`pool.admission.unknown_ram`).
 * - `treeMb` is optional. It resolves the memory in use by the process `pid` and everything below
 *   it, in MB, preferring the proportional share (PSS) when the system has it, or `undefined`.
 *   It never rejects either. The pool uses it for `pool.<client>.session_mb: auto`.
 */
export interface MemoryProbe extends Adapter {
  availableMb(): Promise<number | undefined>;
  treeMb?(pid: number): Promise<number | undefined>;
}
