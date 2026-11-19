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
  /**
   * Local accounting of the usage events; `undefined` when `quota.opencode.mode` is `off` or
   * `codex_link`, or, in `auto`, when no limit of the ledger is configured.
   */
  readonly ledger?: LedgerProbe;
  /**
   * The quota probe of Codex, for a profile linked to a Codex profile of the same ChatGPT account
   * (`codex_link`, N156, P25); `undefined` when the mode is `off` or `ledger`, or Codex is not on.
   */
  readonly codex?: QuotaProbe;
  /**
   * The Codex profile an OpenCode profile declares as the same account (`profiles.<id>.codex_link`),
   * or `undefined`. Synchronous: it is the configuration, read once.
   */
  readonly linkOf?: (profile: ProfileRef) => string | undefined;
  /** The MiniMax Token Plan probe; `undefined` when `quota.minimax.mode` is `off`. */
  readonly minimax?: QuotaProbe;
  /** The provider of a profile (`minimax`, `openai`, ...), from the profile registry. */
  readonly providerOf: (profile: ProfileRef) => Promise<string | undefined>;
  /** Providers whose profiles are read by the MiniMax probe. Default `['minimax']`. */
  readonly minimaxProviders?: readonly string[];
}

type Route = 'minimax' | 'ledger' | 'codex_link';

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
 * - P25 (N156): a profile that declares `codex_link` (and is not a MiniMax one) is read through the
 *   probe of Codex, with the linked Codex profile: the 5h and 7d windows of the ChatGPT account the
 *   two share. The daemon reads no credential for it; the link is what the owner declared. With
 *   the Codex probe watching (`clients.codex.quota.watch: resident`), the link is watched too.
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
    if (options.ledger?.watch !== undefined || options.codex?.watch !== undefined) {
      this.watch = (profile, onChange): Disposable => this.#watch(profile, onChange);
    }
  }

  capabilities(): QuotaCapabilities {
    const { ledger, minimax, codex } = this.#options;
    const windows = new Set<string>();
    for (const probe of [minimax, codex, ledger]) {
      for (const window of probe?.capabilities().windows ?? []) windows.add(window);
    }
    return {
      windows: [...windows],
      delivery: this.watch === undefined ? 'poll' : 'both',
      precision:
        ledger === undefined && (minimax !== undefined || codex !== undefined)
          ? 'exact'
          : 'approximate',
    };
  }

  /** The windows a profile is expected to report, by the route it is on (known after `warm`/`read`). */
  windowsOf(profile: ProfileRef): readonly string[] {
    const route = this.#routes.get(formatProfileId(profile)) ?? this.#linkRoute(profile);
    return this.#probeOf(route)?.capabilities().windows ?? [];
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
    const probe = this.#probeOf(route);
    if (probe === undefined) {
      throw new AdapterUnavailable(
        route === 'codex_link'
          ? `${profile.client}/${profile.profile} is linked to a Codex profile, but no Codex quota probe is on`
          : `no quota source is on for ${profile.client}/${profile.profile} (quota.minimax.mode and quota.opencode.mode)`,
      );
    }
    if (route !== 'codex_link') return probe.read(profile);
    return probe.read(this.#linked(profile));
  }

  /** The probe of a route; the MiniMax and the ledger routes fall back on each other, as before. */
  #probeOf(route: Route | undefined): QuotaProbe | undefined {
    const { ledger, minimax, codex } = this.#options;
    if (route === 'codex_link') return codex;
    return route === 'minimax' ? (minimax ?? ledger) : (ledger ?? minimax);
  }

  /** `codex_link` when the profile declares a link and the Codex probe is on; else nothing. */
  #linkRoute(profile: ProfileRef): Route | undefined {
    return this.#options.codex !== undefined && this.#options.linkOf?.(profile) !== undefined
      ? 'codex_link'
      : undefined;
  }

  #linked(profile: ProfileRef): ProfileRef {
    const link = this.#options.linkOf?.(profile);
    if (link === undefined)
      throw new AdapterUnavailable(`${formatProfileId(profile)} has no codex_link`);
    return { client: 'codex', profile: link };
  }

  async #routeOf(profile: ProfileRef): Promise<Route> {
    const id = formatProfileId(profile);
    const known = this.#routes.get(id);
    if (known !== undefined) return known;
    const provider = await this.#options.providerOf(profile);
    // A profile the registry does not know yet is not cached: it may be added a moment later.
    if (provider === undefined) return this.#linkRoute(profile) ?? 'ledger';
    const route: Route = this.#minimaxProviders.has(provider)
      ? 'minimax'
      : (this.#linkRoute(profile) ?? 'ledger');
    this.#routes.set(id, route);
    return route;
  }

  #watch(profile: ProfileRef, onChange: (reading: QuotaReading) => void): Disposable {
    const { ledger, codex } = this.#options;
    const id = formatProfileId(profile);
    void this.#routeOf(profile).catch(() => undefined);
    const watches: Disposable[] = [];
    // The link is known now (it is configuration); the provider may not be yet.
    if (codex?.watch !== undefined && this.#linkRoute(profile) === 'codex_link') {
      watches.push(
        codex.watch(this.#linked(profile), (reading) => {
          if (this.#routes.get(id) !== 'minimax') onChange(reading);
        }),
      );
    } else if (ledger?.watch !== undefined) {
      watches.push(
        ledger.watch(profile, (reading) => {
          if (this.#routes.get(id) !== 'minimax') onChange(reading);
        }),
      );
    }
    return {
      dispose: () => {
        for (const watch of watches) watch.dispose();
      },
    };
  }
}
