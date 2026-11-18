// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  formatProfileId,
  type AdapterImplements,
  type Disposable,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import type { ProfileWindows, UsageSink, UsageUpdate } from './service.js';

/** The part of the local ledger (the OpenCode probe) the composite needs. */
export type LedgerProbe = QuotaProbe & UsageSink;

export interface ProviderProbeOptions {
  /** Local accounting of the usage events; `undefined` when `quota.opencode.mode` is `off`. */
  readonly ledger?: LedgerProbe;
  /** The MiniMax Token Plan probe; `undefined` when `quota.minimax.mode` is `off`. */
  readonly minimax?: QuotaProbe;
  /** The provider of a profile (`minimax`, `openai`, ...), from the profile registry. */
  readonly providerOf: (profile: ProfileRef) => Promise<string | undefined>;
  /** Providers whose profiles are read by the MiniMax probe. Default `['minimax']`. */
  readonly minimaxProviders?: readonly string[];
}

type Route = 'minimax' | 'ledger';

/**
 * The quota probe of ONE client that can sit in front of several providers (P8): OpenCode takes a
 * MiniMax key on one profile and an OpenAI one on another, and the service keeps one probe per
 * client. This one routes by the provider of the profile: a MiniMax profile is read at the MiniMax
 * Token Plan endpoint, every other one is read in the local ledger. Both can be off; then the
 * probe has nothing to say and `read` refuses, as the plain skeleton did.
 *
 * - Every usage event of every session goes to the ledger, whatever the provider (the sum is cheap
 *   and the owner may turn the ledger on later); the ledger decides whether it counts.
 * - A MiniMax profile with `quota.minimax.mode` off falls back to the ledger, like any other.
 * - The windows a profile is expected to have depend on its route (`windowsOf`), so a MiniMax
 *   profile is not called `unknown` for lacking a ledger window. The provider is looked up once
 *   per profile and kept; `warm` fills it before the first read (the daemon calls it at start).
 * - `watch` exists only when the ledger does, and delivers only for the profiles on the ledger
 *   route; a MiniMax profile is polled.
 */
export class ProviderQuotaProbe implements QuotaProbe, UsageSink, ProfileWindows {
  readonly id = 'provider-quota';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };
  watch?: NonNullable<QuotaProbe['watch']>;
  readonly #options: ProviderProbeOptions;
  readonly #routes = new Map<string, Route>();
  readonly #minimaxProviders: ReadonlySet<string>;

  constructor(options: ProviderProbeOptions) {
    this.#options = options;
    this.#minimaxProviders = new Set(options.minimaxProviders ?? ['minimax']);
    if (options.ledger?.watch !== undefined) {
      this.watch = (profile, onChange): Disposable => this.#watchLedger(profile, onChange);
    }
  }

  capabilities(): QuotaCapabilities {
    const { ledger, minimax } = this.#options;
    const windows = new Set<string>();
    for (const probe of [minimax, ledger]) {
      for (const window of probe?.capabilities().windows ?? []) windows.add(window);
    }
    return {
      windows: [...windows],
      delivery: ledger === undefined ? 'poll' : 'both',
      precision: minimax !== undefined && ledger === undefined ? 'exact' : 'approximate',
    };
  }

  /** The windows a profile is expected to report, by the route it is on (known after `warm`/`read`). */
  windowsOf(profile: ProfileRef): readonly string[] {
    const route = this.#routes.get(formatProfileId(profile));
    const { ledger, minimax } = this.#options;
    const probe = route === 'minimax' ? (minimax ?? ledger) : (ledger ?? minimax);
    return probe?.capabilities().windows ?? [];
  }

  recordUsage(profile: ProfileRef, sessionId: string, usage: UsageUpdate): void {
    this.#options.ledger?.recordUsage(profile, sessionId, usage);
  }

  /** Looks up the provider of each profile now, so `windowsOf` is right before the first read. */
  async warm(profiles: readonly ProfileRef[]): Promise<void> {
    await Promise.all(profiles.map((profile) => this.#routeOf(profile)));
  }

  async read(profile: ProfileRef): Promise<QuotaReading> {
    const route = await this.#routeOf(profile);
    const { ledger, minimax } = this.#options;
    const probe = route === 'minimax' && minimax !== undefined ? minimax : ledger;
    if (probe === undefined) {
      throw new AdapterUnavailable(
        `no quota source is on for ${profile.client}/${profile.profile} (quota.minimax.mode and quota.opencode.mode are off)`,
      );
    }
    return probe.read(profile);
  }

  async #routeOf(profile: ProfileRef): Promise<Route> {
    const id = formatProfileId(profile);
    const known = this.#routes.get(id);
    if (known !== undefined) return known;
    const provider = await this.#options.providerOf(profile);
    // A profile the registry does not know yet is not cached: it may be added a moment later.
    if (provider === undefined) return 'ledger';
    const route: Route = this.#minimaxProviders.has(provider) ? 'minimax' : 'ledger';
    this.#routes.set(id, route);
    return route;
  }

  #watchLedger(profile: ProfileRef, onChange: (reading: QuotaReading) => void): Disposable {
    const ledger = this.#options.ledger;
    if (ledger?.watch === undefined) return { dispose: () => undefined };
    const id = formatProfileId(profile);
    void this.#routeOf(profile).catch(() => undefined);
    return ledger.watch(profile, (reading) => {
      if (this.#routes.get(id) !== 'minimax') onChange(reading);
    });
  }
}
