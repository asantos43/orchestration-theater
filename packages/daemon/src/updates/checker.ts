// SPDX-License-Identifier: MPL-2.0
import { stat } from 'node:fs/promises';
import { Cancelled, type Clock } from '@otheater/core';
import {
  UPDATE_REASONS,
  UPDATE_RESULTS,
  type ApiUpdateApply,
  type ApiUpdateStatus,
  type DaemonUpdatePayload,
  type UpdatePhase,
  type UpdateReason,
} from '@otheater/protocol';
import semver from 'semver';
import type { UpdatesConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { situationSubject, type SituationSink } from '../situations.js';
import { phaseOf, UpdateStop } from './errors.js';
import type { UpdateInstallKind } from './install.js';
import { assetFor, parseManifest } from './manifest.js';
import type { UpdateSource } from './source.js';
import type { UpdateStaging } from './staging.js';
import { sha256OfFile, verifySignature, type PublicKeyResult } from './verify.js';

/**
 * The search for a new version, and the state machine of the modes (Phase 10, P7; architecture
 * 5.21, N73). Discover, download and check; applying is the next step (P8), so nothing here replaces
 * an executable file.
 *
 * The order of one search, and the only order (docs/21, "Formato dos artefatos e da assinatura"):
 * 1. the manifest and its signature come from the origin;
 * 2. the signature is checked with the embedded key; only then is the manifest read;
 * 3. the channel must be the one asked for;
 * 4. a version that is not newer than the installed one is refused (a replayed manifest);
 * 5. the executable of the platform is downloaded to a name no one reads;
 * 6. its size and its SHA-256 must be the ones of the manifest (which the signature covers);
 * 7. only then is it stored, as `ready`.
 * Any failure deletes the download, tells `daemon.update` with `phase: rejected` and the reason,
 * and raises a `daemon.notice` of kind `update_rejected` for the global chat.
 *
 * Modes ([proposta]):
 * - `off`: never searches; `POST /v1/updates/check` answers 409;
 * - `check`: reads the manifest and says a newer version exists (`found`); downloads nothing;
 * - `notify`: also downloads, checks and stores the version, and says it is ready;
 * - `auto`: what `notify` does, and it also applies the version (P8: `updates.apply_when` says when,
 *   see `apply/coordinator.ts`);
 * - a daemon that is not the own executable (a checkout run by Node) acts as `check`;
 * - a build without a valid public key searches nothing: it cannot check what it would get.
 */

export type UpdateResult = (typeof UPDATE_RESULTS)[number];
type ActiveMode = 'auto' | 'notify' | 'check';
type EffectiveMode = ActiveMode | 'off';

/** The reasons a version is refused for (the ones of the phase `rejected`). */
export const REJECTION_REASONS: readonly UpdateReason[] = UPDATE_REASONS.filter(
  (reason) => phaseOf(reason) === 'rejected',
);

/**
 * What the checker tells the step that applies a version (P8). The checker knows nothing else of
 * it: no module of the search imports the swap.
 */
export interface UpdateApplyHooks {
  /** The state of the application, for `GET /v1/updates`. */
  readonly status: () => ApiUpdateApply;
  /** The version that is ready now (`null`: none); `restored` when found on disk at the start. */
  readonly ready: (version: string | null, restored: boolean) => void;
}

/** What `otheater_updates_*` counts. */
export interface UpdateCounters {
  readonly checks: Readonly<Record<UpdateResult, number>>;
  readonly rejected: Readonly<Record<string, number>>;
}

export interface UpdateCheckerOptions {
  readonly settings: UpdatesConfig;
  /** The installed version. */
  readonly currentVersion: string;
  /** `linux-x64`, `win32-x64` or `darwin-arm64`. */
  readonly platform: string;
  readonly installKind: UpdateInstallKind;
  /** The public key the manifest is checked with; the checker never reads one from anywhere else. */
  readonly key: PublicKeyResult;
  readonly source: UpdateSource;
  readonly staging: UpdateStaging;
  readonly clock: Clock;
  readonly situations: SituationSink;
  readonly logger: Pick<Logger, 'warn' | 'error' | 'info' | 'debug'>;
  /** The step that applies a ready version (P8); without it the version only waits. */
  readonly applier?: UpdateApplyHooks | undefined;
}

interface Context {
  readonly manual: boolean;
  version: string | null;
}

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

export class UpdateChecker {
  readonly #o: UpdateCheckerOptions;
  readonly #abort = new AbortController();
  readonly #current: string;
  readonly #told = new Set<string>();
  readonly #checks = zeroed(UPDATE_RESULTS);
  readonly #rejected = zeroed(REJECTION_REASONS);
  #loop: Promise<void> | undefined;
  #running: Promise<ApiUpdateStatus> | undefined;
  #checkedAt: number | null = null;
  #nextAt: number | null = null;
  #lastResult: UpdateResult | null = null;
  #lastReason: UpdateReason | null = null;
  #found: string | null = null;
  #readyVersion: string | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.#o = options;
    this.#current = semver.valid(options.currentVersion) ?? '0.0.0';
  }

  /** The mode the daemon acts in, and why it is not the one in the file. */
  #effective(): { readonly mode: EffectiveMode; readonly notes: ApiUpdateStatus['notes'] } {
    const asked = this.#o.settings.mode;
    if (asked === 'off') return { mode: 'off', notes: [] };
    const notes: ApiUpdateStatus['notes'] = [];
    if (this.#o.key.state !== 'valid') notes.push('no_public_key');
    if (this.#o.installKind === 'checkout') {
      notes.push('checkout_install');
      return { mode: 'check', notes };
    }
    if (this.#o.key.state !== 'valid') return { mode: 'check', notes };
    return { mode: asked, notes };
  }

  /** The state of the application when nothing applies (no step, or a build that cannot). */
  #noApply(): ApiUpdateApply {
    return {
      when: this.#o.settings.apply_when,
      rollback: this.#o.settings.rollback,
      state: 'none',
      version: null,
      since: null,
      askAt: null,
      last: null,
    };
  }

  /** Sets the version that is ready and tells the step that applies it. */
  #setReady(version: string | null, restored: boolean): void {
    this.#readyVersion = version;
    this.#o.applier?.ready(version, restored);
  }

  /** A version the apply step refused: it is no longer offered. */
  forget(version: string): void {
    if (this.#readyVersion === version) this.#setReady(null, false);
    if (this.#found === version) this.#found = null;
  }

  status(): ApiUpdateStatus {
    const { mode, notes } = this.#effective();
    const iso = (ms: number | null): string | null =>
      ms === null ? null : new Date(ms).toISOString();
    return {
      mode: this.#o.settings.mode,
      effectiveMode: mode,
      channel: this.#o.settings.channel,
      source: this.#o.settings.source,
      installKind: this.#o.installKind,
      currentVersion: this.#o.currentVersion,
      platform: this.#o.platform,
      keyState: this.#o.key.state,
      notes: [...notes],
      checkedAt: iso(this.#checkedAt),
      nextCheckAt: iso(this.#nextAt),
      lastResult: this.#lastResult,
      found: this.#found,
      ready: this.#readyVersion,
      apply: this.#o.applier?.status() ?? this.#noApply(),
      lastReason: this.#lastReason,
    };
  }

  counters(): UpdateCounters {
    return { checks: { ...this.#checks }, rejected: { ...this.#rejected } };
  }

  /**
   * Starts the schedule in the background: the first search does not hold the start of the daemon
   * (an origin that does not answer only makes that search `failed`). With `mode: off` nothing runs.
   */
  start(): void {
    if (this.#loop !== undefined || this.#o.settings.mode === 'off') return;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
    await this.#running?.catch(() => undefined);
  }

  async #run(): Promise<void> {
    try {
      await this.#restore();
      await this.#search(false);
      const interval = this.#o.settings.check_interval;
      while (interval !== null) {
        this.#nextAt = this.#o.clock.now() + interval;
        await this.#o.clock.sleep(interval, this.#abort.signal);
        await this.#search(false);
      }
    } catch (error) {
      if (!this.#abort.signal.aborted && !(error instanceof Cancelled)) {
        this.#o.logger.warn({ err: error }, 'the schedule of the search for updates stopped');
      }
    }
    this.#nextAt = null;
  }

  /** A version stored by an earlier run is `ready` again, if it is still newer than this one. */
  async #restore(): Promise<void> {
    const staged = await this.#o.staging.ready();
    await this.#o.staging.sweep();
    if (staged !== undefined && semver.gt(staged.version, this.#current)) {
      this.#found = staged.version;
      this.#setReady(staged.version, true);
    } else if (staged !== undefined) {
      // Already installed (or older): nothing waits for it, and it takes up the disk.
      await this.#o.staging.drop(staged.version);
    }
  }

  /** A search now, at the request of the Producer. A search already going on is the answer. */
  async checkNow(): Promise<ApiUpdateStatus> {
    return await this.#search(true);
  }

  #search(manual: boolean): Promise<ApiUpdateStatus> {
    this.#running ??= (async () => {
      try {
        await this.#once({ manual, version: null });
      } finally {
        this.#running = undefined;
      }
      return this.status();
    })();
    return this.#running;
  }

  async #once(context: Context): Promise<void> {
    const { mode } = this.#effective();
    if (mode === 'off') return;
    let result: UpdateResult;
    try {
      result = await this.#attempt(mode, context);
      this.#lastReason = null;
      this.#told.delete('failed');
    } catch (error) {
      result = this.#stopped(error, mode, context);
    }
    this.#checks[result] += 1;
    this.#lastResult = result;
    this.#checkedAt = this.#o.clock.now();
  }

  async #attempt(mode: ActiveMode, context: Context): Promise<UpdateResult> {
    const { key, source, staging, settings } = this.#o;
    if (key.state !== 'valid') {
      throw new UpdateStop('no_public_key', 'this build has no public key to check a release with');
    }
    const files = await source.fetchRelease(settings.channel, this.#abort.signal);
    if (files === undefined) {
      this.#found = null;
      this.#setReady(null, false);
      return 'up_to_date';
    }
    // 2. The signature first; the manifest is not read before it checks.
    if (!verifySignature(files.manifest, files.signature, key.key)) {
      throw new UpdateStop('signature', 'the signature of the manifest does not check');
    }
    const manifest = parseManifest(files.manifest);
    context.version = manifest.version;
    // 3. 4. The channel, and no downgrade or replay.
    if (manifest.channel !== settings.channel) {
      throw new UpdateStop(
        'wrong_channel',
        `the manifest is of channel ${manifest.channel}`,
        manifest.version,
      );
    }
    if (semver.eq(manifest.version, this.#current)) {
      this.#found = null;
      this.#setReady(null, false);
      return 'up_to_date';
    }
    if (semver.lt(manifest.version, this.#current)) {
      throw new UpdateStop(
        'version_not_newer',
        `the manifest is of ${manifest.version}, older than ${this.#current}`,
        manifest.version,
      );
    }
    if (manifest.minVersion !== undefined && semver.lt(this.#current, manifest.minVersion)) {
      throw new UpdateStop(
        'below_min_version',
        `${manifest.version} needs at least ${manifest.minVersion}`,
        manifest.version,
      );
    }
    this.#found = manifest.version;
    this.#tell('found', manifest.version, null, mode, `found:${manifest.version}`, context.manual);
    if (mode === 'check') return 'found';

    const asset = assetFor(manifest, this.#o.platform);
    if (asset === undefined) {
      throw new UpdateStop(
        'no_asset',
        `there is no file for ${this.#o.platform}`,
        manifest.version,
      );
    }
    const staged = await staging.ready();
    if (
      staged?.version === manifest.version &&
      staged.asset.sha256 === asset.sha256 &&
      staged.asset.size === asset.size
    ) {
      this.#setReady(manifest.version, false);
      return 'ready';
    }

    // 5. 6. 7. The download has a name no one reads until size and SHA-256 are the signed ones.
    const partial = await staging.partialPath();
    try {
      await source.download(files.fileUrl(asset.name), partial, asset.size, this.#abort.signal);
      this.#tell(
        'downloaded',
        manifest.version,
        null,
        mode,
        `downloaded:${manifest.version}`,
        true,
      );
      const size = await sizeOf(partial);
      if (size !== asset.size) {
        throw new UpdateStop(
          'size',
          `the file has ${String(size)} bytes, the manifest says ${String(asset.size)}`,
          manifest.version,
        );
      }
      if ((await sha256OfFile(partial)) !== asset.sha256) {
        throw new UpdateStop(
          'sha256',
          'the SHA-256 of the file is not the one of the manifest',
          manifest.version,
        );
      }
      await staging.commit({
        version: manifest.version,
        channel: manifest.channel,
        platform: this.#o.platform,
        asset,
        partial,
        manifest: files.manifest,
        signature: files.signature,
        storedAt: this.#o.clock.now(),
      });
    } catch (error) {
      await staging.discard(partial);
      throw error;
    }
    this.#setReady(manifest.version, false);
    this.#tell('verified', manifest.version, null, mode, `verified:${manifest.version}`, true);
    return 'ready';
  }

  /** A search that ended in a stop: what is told, counted and kept. */
  #stopped(error: unknown, mode: ActiveMode, context: Context): UpdateResult {
    const stop =
      error instanceof UpdateStop
        ? error
        : new UpdateStop(
            'bad_response',
            error instanceof Error ? error.message : String(error),
            context.version,
          );
    if (!(error instanceof UpdateStop)) {
      this.#o.logger.error(
        { err: error },
        'the search for updates failed in a way it did not expect',
      );
    }
    if (this.#abort.signal.aborted) return 'failed';
    const phase = stop.phase;
    const version = stop.version ?? context.version;
    this.#lastReason = stop.reason;
    this.#o.logger.warn(
      { reason: stop.reason, version, phase },
      `update ${phase}: ${stop.message}`,
    );
    if (phase === 'rejected') {
      this.#rejected[stop.reason] += 1;
      // A version that was refused is not offered, whatever an earlier search found.
      this.#setReady(this.#readyVersion === version ? null : this.#readyVersion, false);
    }
    // A build with no key, run from a checkout, is not a situation: it is how a checkout is.
    const quiet =
      stop.reason === 'no_public_key' && this.#o.installKind === 'checkout' && !context.manual;
    if (!quiet) {
      const key = phase === 'failed' ? 'failed' : `${phase}:${stop.reason}:${version ?? ''}`;
      if (
        this.#tell(phase, version, stop.reason, mode, key, context.manual) &&
        phase === 'rejected'
      ) {
        this.#o.situations.record('daemon.notice', {
          kind: 'update_rejected',
          subject: version === null ? null : situationSubject(version),
          detail: stop.reason,
        });
      }
    }
    // A search never ends in a rollback (that is the apply step's); `failed` is the nearest result.
    return phase === 'rolled_back' ? 'failed' : phase;
  }

  /**
   * Writes a `daemon.update` event. The same fact is not told twice in a row (a refused manifest that
   * stays refused is told once per version and reason, an origin that stays down once), unless the
   * Producer asked for the search. Returns whether the event was written.
   */
  #tell(
    phase: UpdatePhase,
    version: string | null,
    reason: UpdateReason | null,
    mode: ActiveMode,
    key: string,
    always: boolean,
  ): boolean {
    if (!always && this.#told.has(key)) return false;
    this.#told.add(key);
    const payload: DaemonUpdatePayload = {
      phase,
      version,
      current: this.#o.currentVersion,
      channel: this.#o.settings.channel,
      mode: this.#o.settings.mode === 'off' ? mode : this.#o.settings.mode,
      effectiveMode: mode,
      reason,
    };
    this.#o.situations.record('daemon.update', payload);
    return true;
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    throw new UpdateStop('storage', 'the download is not on disk');
  }
}
