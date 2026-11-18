// SPDX-License-Identifier: MPL-2.0
import type { Profile } from '@otheater/core';
import type { LocalConfig } from '@otheater/protocol';

/**
 * What decides whether the pool admits a session (architecture 5.9, "Controle de admissão"; Phase 5,
 * P4). [proposta] Every mode and default below is a configuration key (`pool.admission.*`).
 *
 * - `slots`: the vacancies alone (`pool.max_sessions` and the slots of a local instance). This is
 *   the behaviour from before P4, and the default.
 * - `ram`: the vacancies, and the free RAM must hold the estimated cost of the session on top of
 *   `pool.admission.min_free_mb`.
 * - `ram_and_quota`: `ram`, and the quota hook `canAdmit(profile)` must say yes.
 */
export const ADMISSION_MODES = ['slots', 'ram', 'ram_and_quota'] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

/** What the pool does when the `MemoryProbe` cannot tell the free RAM: let the session in, or wait. */
export const UNKNOWN_RAM_MODES = ['admit', 'wait'] as const;
export type UnknownRamMode = (typeof UNKNOWN_RAM_MODES)[number];

/** The cost of one session of a client in MB, or `auto` (learn it from the process tree). */
export type SessionMb = number | 'auto';

export interface AdmissionSettings {
  readonly mode: AdmissionMode;
  /** The RAM that must stay free after the session is admitted (`pool.admission.min_free_mb`). */
  readonly minFreeMb: number;
  /** While a session waits for RAM or quota, how often the pool looks again (`pool.admission.recheck`). */
  readonly recheckMs: number;
  /** `pool.admission.unknown_ram`. */
  readonly unknownRam: UnknownRamMode;
}

/** [proposta] The defaults of `pool.admission`: the behaviour of before P4, with a cautious floor. */
export const DEFAULT_ADMISSION: AdmissionSettings = {
  mode: 'slots',
  minFreeMb: 2048,
  recheckMs: 5000,
  unknownRam: 'admit',
};

/**
 * [proposta] The cost of one session, by client, in MB. Measured on 2026-11-16 (N74, one round,
 * Linux, `--level k`): the PSS per session after a short prompt, with the process alone, was 313.6
 * MB for Claude Code, 150.1 MB for Codex and 521.9 MB for OpenCode [V]. The values here round them
 * up. Shared processes cost less per session (Codex 60.1 MB at `K` = 6, OpenCode 235.6 MB at
 * `K` = 4), so these are the cautious end.
 */
export const DEFAULT_SESSION_MB = {
  'claude-code': 320,
  codex: 150,
  opencode: 520,
} as const;

/** [proposta] The cost of a client the table above does not know. */
export const FALLBACK_SESSION_MB = 512;

/** The measured default cost of one session of `client`, or {@link FALLBACK_SESSION_MB}. */
export function defaultSessionMb(client: string): number {
  return (DEFAULT_SESSION_MB as Readonly<Record<string, number>>)[client] ?? FALLBACK_SESSION_MB;
}

/**
 * Asks the quota whether a session of this profile may start (the `canAdmit(perfil)` hook of the
 * plan). Phase 5, P15, wires it to the `QuotaService`; until then {@link ALWAYS_ADMIT} says yes. A
 * rejection counts as "no": the session waits and the pool asks again at the next recheck.
 */
export type CanAdmit = (profile: Profile) => boolean | Promise<boolean>;

export const ALWAYS_ADMIT: CanAdmit = () => true;

/**
 * The local model instance behind a profile (architecture 5.9, "Modelo local"): its `slots` are the
 * vacancies of the pool for that profile, and part of them is kept for the Director.
 */
export interface LocalInstance {
  /** Sessions the instance serves at once (`slots`, with `auto` already read from the server). */
  readonly slots: number;
  /** `reserve_for_director`: `0`, a number of slots, or `all`. */
  readonly reserveForDirector: number | 'all';
  /** `reserve_when`: `listed` keeps them only for a profile in the Director's list. */
  readonly reserveWhen: LocalConfig['reserve_when'];
}

/** What the pool asks for the `local` block of a profile; `undefined` for a profile with none. */
export type LocalInstanceResolver = (profile: Profile) => LocalInstance | undefined;

/**
 * The instance of a `local` block, after the number of slots was read: `slots: auto` takes
 * `detectedSlots` (what `LocalModelServer.slots` said), and without a reading it is 1 (5.9).
 */
export function localInstanceOf(
  config: Pick<LocalConfig, 'slots' | 'reserve_for_director' | 'reserve_when'>,
  detectedSlots: number | undefined,
): LocalInstance {
  const slots = config.slots === 'auto' ? Math.max(1, detectedSlots ?? 1) : config.slots;
  return {
    slots,
    reserveForDirector: config.reserve_for_director,
    reserveWhen: config.reserve_when,
  };
}

/**
 * How many slots of the instance only the Director may use. `listed`: only when the profile is in
 * the Director's list; `always`: whatever the list; `never`: none. `all` reserves the instance whole
 * and a number never reserves more than there is.
 */
export function reservedSlots(instance: LocalInstance, listedForDirector: boolean): number {
  const applies =
    instance.reserveWhen === 'always' || (instance.reserveWhen === 'listed' && listedForDirector);
  if (!applies) return 0;
  return instance.reserveForDirector === 'all'
    ? instance.slots
    : Math.min(instance.reserveForDirector, instance.slots);
}

/** The sessions of one profile that hold a slot of its instance. */
export interface ProfileLoad {
  /** Sessions of the Director (or a short judgement of it). */
  directors: number;
  /** Sessions of any other role. */
  actors: number;
}

/**
 * Whether the instance has a slot for one more session. The Director takes any free slot. Another
 * role takes a free slot only if it is not one of those reserved: with `slots: 2` and one reserved,
 * an Actor holds at most one slot even while the other is free.
 */
export function slotFree(
  instance: LocalInstance,
  load: ProfileLoad,
  director: boolean,
  listedForDirector: boolean,
): boolean {
  if (load.directors + load.actors >= instance.slots) return false;
  if (director) return true;
  return load.actors < instance.slots - reservedSlots(instance, listedForDirector);
}
