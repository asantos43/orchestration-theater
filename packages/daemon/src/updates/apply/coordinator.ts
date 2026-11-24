// SPDX-License-Identifier: MPL-2.0
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Cancelled, type Clock } from '@otheater/core';
import type {
  ApiUpdateApply,
  DaemonUpdatePayload,
  UpdatePhase,
  UpdateReason,
} from '@otheater/protocol';
import type { UpdatesConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { situationSubject, type SituationSink } from '../../situations.js';
import { phaseOf, UpdateStop } from '../errors.js';
import { assetFor, parseManifest, type UpdateManifest } from '../manifest.js';
import type { StagedUpdate, UpdateStaging } from '../staging.js';
import { sha256Hex, sha256OfFile, verifySignature, type PublicKeyResult } from '../verify.js';
import { checkManifestPolicy } from '../policy.js';
import { FINAL_STEPS, readJournal, writeJournal, type UpdateJournal } from './journal.js';
import type { InstallLayout } from './layout.js';
import { migrationTestHook } from './test-migration.js';
import { checkJournalTrust, PROOF_MANIFEST, PROOF_SIGNATURE, type JournalTrust } from './trust.js';

/**
 * Applying the version that is ready (Phase 10, P8; architecture 5.21, N73). The checker (P7) says
 * a version is ready; this decides when to apply it (`updates.apply_when`), prepares the swap and
 * starts the applier (`applier.ts`), then shuts the daemon down the clean way. The swap itself
 * is the applier's; here it is only started, and the daemon that comes back reads the journal to
 * say how it ended (`daemon.update`: `applied`, `rolled_back`, `failed`).
 *
 * The moments ([proposta]):
 * - `idle`: new work is held back (`work.hold()`); when no attempt is running the version is
 *   applied. If `max_wait` goes by first, the hold is released and the Producer is asked, in the
 *   global chat, between `park` and `wait` (`POST /v1/updates/apply`);
 * - `park`: applied at once; the clean stop leaves the sessions `awaiting_resume`, which is the
 *   "restart of the daemon" of 5.16 (no attempt is spent) and they come back by `session/load`;
 * - `next_start`: left ready; applied the next time the daemon starts.
 * Only the mode `auto` applies by itself; in `notify` the Producer applies with `POST` (and
 * `how: park`, or `default` for an `idle` or `park` `apply_when`).
 */

export type ApplyHow = 'default' | 'park' | 'wait';

/** A request the daemon refuses; the route turns it into 409 `conflict` or 503 `unavailable`. */
export class ApplyRefusal extends Error {
  readonly code: 'conflict' | 'unavailable';

  constructor(code: 'conflict' | 'unavailable', message: string) {
    super(message);
    this.name = 'ApplyRefusal';
    this.code = code;
  }
}

/** What the coordinator needs of the attempt runner. */
export interface ApplyWork {
  /** How many attempts are running. */
  readonly active: () => number;
  readonly hold: () => void;
  readonly release: () => void;
}

/** The newest migration of each base this daemon has (the manifest says what the new one needs). */
export interface OwnSchemas {
  readonly store: number;
  readonly telemetry: number;
}

export type BackupResult =
  { readonly ok: true; readonly dir: string } | { readonly ok: false; readonly detail: string };

type EffectiveMode = 'auto' | 'notify' | 'check' | 'off';

export interface ApplyCoordinatorOptions {
  readonly settings: UpdatesConfig;
  /** The installed version. */
  readonly version: string;
  readonly dataDir: string;
  /** Where the installation is; `undefined` for a checkout (nothing is applied). */
  readonly layout: InstallLayout | undefined;
  readonly key: PublicKeyResult;
  readonly platform: string;
  readonly staging: UpdateStaging;
  readonly clock: Clock;
  readonly situations: SituationSink;
  readonly logger: Pick<Logger, 'warn' | 'error' | 'info' | 'debug'>;
  readonly work: ApplyWork | undefined;
  /** Makes the backup of the instance (`trigger: update`); `undefined`: this store cannot. */
  readonly backup: (() => Promise<BackupResult>) | undefined;
  readonly ownSchemas: OwnSchemas;
  /** Starts the applier (detached) from `applierExe`: the stored copy of the new version. */
  readonly launch: (layout: InstallLayout, applierExe: string) => Promise<void>;
  /** The clean shutdown of the daemon (`stop('shutdown')`). */
  readonly shutdown: () => Promise<void>;
  /** The mode the checker acts in (it depends on the install and the key, not only on the file). */
  readonly effectiveMode: () => EffectiveMode;
  /** Tells the checker a version it offered is no longer to be offered. */
  readonly forget: (version: string) => void;
  /** `true` in the release build: the `OT_TEST_MIGRATION` hook does nothing there. */
  readonly releaseBuild?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** The time between two looks at the running attempts. Default 5 s. */
  readonly idlePollMs?: number | undefined;
  /** The time between two looks at the journal while a swap is under way. Default 2 s. */
  readonly reportPollMs?: number | undefined;
  /** How long the new daemon must hold after its first good answer. Default 30 s. */
  readonly stableMs?: number | undefined;
  /** The pid the journal calls the old daemon. Default: this process. */
  readonly pid?: number | undefined;
}

const IDLE_POLL_MS = 5000;
const REPORT_POLL_MS = 2000;
const STABLE_MS = 30_000;

type ApplyState = ApiUpdateApply['state'];

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export class ApplyCoordinator {
  readonly #o: ApplyCoordinatorOptions;
  readonly #abort = new AbortController();
  /** Ends the wait of `idle`; one per wait. */
  #idle: AbortController | undefined;
  #loops = new Set<Promise<void>>();
  #state: ApplyState = 'none';
  #since: number | null = null;
  #askAt: number | null = null;
  #version: string | null = null;
  #last: ApiUpdateApply['last'] = null;
  /** Versions the Producer asked for by hand, which the journal of an earlier failure does not stop. */
  readonly #allowed = new Set<string>();
  #reporter: Promise<void> | undefined;

  constructor(options: ApplyCoordinatorOptions) {
    this.#o = options;
  }

  // ---- what the checker and the routes see -------------------------------------------------

  status(): ApiUpdateApply {
    return {
      when: this.#o.settings.apply_when,
      rollback: this.#o.settings.rollback,
      state: this.#state,
      version: this.#state === 'none' ? null : this.#version,
      since: iso(this.#since),
      askAt: iso(this.#askAt),
      last: this.#last,
    };
  }

  /**
   * The checker says which version is ready now (`null`: none, or it is no longer offered).
   * `restored` is a version found on disk at the start of the daemon (what `next_start` applies).
   */
  ready(version: string | null, restored: boolean): void {
    this.#onReady(version, restored).catch((error: unknown) => {
      this.#o.logger.error(
        { err: error },
        'update: the apply step failed in a way it did not expect',
      );
    });
  }

  async #onReady(version: string | null, restored: boolean): Promise<void> {
    if (this.#o.layout === undefined || this.#state === 'applying') return;
    if (version === null) {
      this.#version = null;
      this.#cancelWait();
      this.#set('none');
      return;
    }
    if (this.#version === version && this.#state !== 'none') return;
    this.#cancelWait();
    this.#version = version;
    this.#set('none');
    if (this.#o.effectiveMode() !== 'auto') return;
    if (await this.#blocked(version)) {
      this.#o.logger.warn(
        { version },
        'update: this version was applied before and rolled back; it is not applied again by itself',
      );
      return;
    }
    switch (this.#o.settings.apply_when) {
      case 'idle':
        this.#startIdle();
        return;
      case 'park':
        this.#startApply();
        return;
      case 'next_start':
        if (restored) this.#startApply();
        else this.#set('scheduled');
        return;
    }
  }

  /**
   * The Producer asks to apply the ready version (`POST /v1/updates/apply`). Answers the status; an
   * apply that starts goes on in the background (the answer cannot wait for the daemon to stop).
   */
  request(how: ApplyHow): ApiUpdateApply {
    const layout = this.#o.layout;
    const mode = this.#o.effectiveMode();
    if (layout === undefined) {
      throw new ApplyRefusal(
        'conflict',
        'This daemon runs from a checkout: it cannot replace itself',
      );
    }
    if (mode === 'off' || mode === 'check') {
      throw new ApplyRefusal(
        'conflict',
        `updates.mode acts as ${mode}: no version is downloaded to apply`,
      );
    }
    if (this.#state === 'applying') {
      throw new ApplyRefusal('conflict', 'A version is already being applied');
    }
    const version = this.#version;
    if (version === null) throw new ApplyRefusal('conflict', 'No version is ready to apply');

    if (how === 'wait') {
      if (this.#state !== 'asked' && this.#state !== 'waiting') {
        throw new ApplyRefusal('conflict', 'The daemon is not waiting to apply a version');
      }
      this.#cancelWait();
      this.#startIdle();
      return this.status();
    }
    this.#allowed.add(version);
    if (how === 'park') {
      this.#cancelWait();
      this.#startApply();
      return this.status();
    }
    // `default`: what `apply_when` says. Already waiting or scheduled: that is the answer.
    if (this.#state !== 'none') return this.status();
    switch (this.#o.settings.apply_when) {
      case 'idle':
        this.#startIdle();
        return this.status();
      case 'park':
        this.#startApply();
        return this.status();
      case 'next_start':
        if (mode !== 'auto') {
          throw new ApplyRefusal(
            'conflict',
            'updates.apply_when is next_start and updates.mode is notify, which never applies at the start: ask with how "park"',
          );
        }
        this.#set('scheduled');
        return this.status();
    }
  }

  // ---- the wait of `idle` -----------------------------------------------------------------

  #set(state: ApplyState): void {
    this.#state = state;
    this.#since = state === 'none' ? null : this.#o.clock.now();
    if (state !== 'waiting' && state !== 'asked') this.#askAt = null;
  }

  #cancelWait(): void {
    this.#idle?.abort();
    this.#idle = undefined;
    this.#o.work?.release();
  }

  #track(task: Promise<void>): void {
    this.#loops.add(task);
    void task.finally(() => this.#loops.delete(task));
  }

  #startIdle(): void {
    const control = new AbortController();
    this.#idle = control;
    this.#set('waiting');
    this.#askAt = this.#o.clock.now() + this.#o.settings.max_wait;
    this.#o.work?.hold();
    this.#track(
      this.#idleLoop(control.signal).catch((error: unknown) => {
        if (!control.signal.aborted && !(error instanceof Cancelled)) {
          this.#o.logger.error({ err: error }, 'update: the wait for an idle daemon failed');
        }
      }),
    );
  }

  async #idleLoop(signal: AbortSignal): Promise<void> {
    const { work, clock } = this.#o;
    for (;;) {
      if (signal.aborted) return;
      if (work === undefined || work.active() === 0) {
        this.#startApply();
        return;
      }
      if (this.#askAt !== null && clock.now() >= this.#askAt) {
        this.#ask();
        return;
      }
      await clock.sleep(this.#o.idlePollMs ?? IDLE_POLL_MS, signal);
    }
  }

  /** The `max_wait` ended with work still going on: the new work goes on, and the Producer chooses. */
  #ask(): void {
    this.#o.work?.release();
    this.#set('asked');
    this.#askAt = null;
    const version = this.#version;
    this.#o.logger.warn(
      { version },
      'update: max_wait ended with work running; asking the Producer',
    );
    this.#o.situations.record('daemon.notice', {
      kind: 'update_ask',
      subject: version === null ? null : situationSubject(version),
      detail: 'park|wait',
    });
  }

  // ---- the apply -----------------------------------------------------------------------------

  #startApply(): void {
    if (this.#state === 'applying') return;
    this.#idle?.abort();
    this.#idle = undefined;
    this.#set('applying');
    // Not tracked in `#loops`: it ends in the shutdown of the daemon, and `stop()` waits for the loops.
    void this.#applyNow().catch((error: unknown) => {
      this.#o.logger.error({ err: error }, 'update: the apply failed in a way it did not expect');
      this.#giveUp();
    });
  }

  /** The apply ended before the daemon stopped: back to waiting for the next try. */
  #giveUp(): void {
    this.#o.work?.release();
    this.#set('none');
  }

  #tell(phase: UpdatePhase, version: string | null, reason: UpdateReason | null): void {
    const asked = this.#o.settings.mode;
    const effective = this.#o.effectiveMode();
    const effectiveMode = effective === 'off' ? 'check' : effective;
    const payload: DaemonUpdatePayload = {
      phase,
      version,
      current: this.#o.version,
      channel: this.#o.settings.channel,
      mode: asked === 'off' ? effectiveMode : asked,
      effectiveMode,
      reason,
    };
    this.#o.situations.record('daemon.update', payload);
  }

  /** The staged version, checked again: it sat on disk since the search, and the apply trusts nothing. */
  async #verifyStaged(version: string): Promise<{
    staged: StagedUpdate;
    manifest: UpdateManifest;
    manifestBytes: Buffer;
    signature: string;
  }> {
    const staged = await this.#o.staging.ready();
    if (staged?.version !== version) {
      throw new UpdateStop('storage', 'the stored version is gone', version);
    }
    if (this.#o.key.state !== 'valid') {
      throw new UpdateStop('no_public_key', 'this build has no public key', version);
    }
    const folder = dirname(staged.file);
    let manifestBytes: Buffer;
    let signature: string;
    try {
      manifestBytes = await readFile(join(folder, 'manifest.json'));
      signature = await readFile(join(folder, 'manifest.json.sig'), 'utf8');
    } catch {
      throw new UpdateStop('bad_manifest', 'the stored manifest cannot be read', version);
    }
    if (!verifySignature(manifestBytes, signature, this.#o.key.key)) {
      throw new UpdateStop('signature', 'the stored manifest does not check any more', version);
    }
    const manifest = parseManifest(manifestBytes);
    const asset = assetFor(manifest, this.#o.platform);
    if (manifest.version !== version || asset === undefined) {
      throw new UpdateStop('bad_manifest', 'the stored manifest is not the version', version);
    }
    // The channel, the minimum version and the expiry of now: the stored version has sat on disk (P8a).
    checkManifestPolicy(manifest, {
      channel: this.#o.settings.channel,
      current: this.#o.version,
      expiry: this.#o.settings.manifest_expiry,
      now: this.#o.clock.now(),
    });
    if (asset.sha256 !== staged.asset.sha256 || asset.size !== staged.asset.size) {
      throw new UpdateStop('sha256', 'the stored file is not the one of the manifest', version);
    }
    if ((await sha256OfFile(staged.file)) !== asset.sha256) {
      throw new UpdateStop('sha256', 'the stored file changed on disk', version);
    }
    return { staged, manifest, manifestBytes, signature };
  }

  /** Whether the new version may need a database this one cannot read back (so a backup is made). */
  #needsBackup(manifest: UpdateManifest): boolean {
    if (!this.#o.settings.backup_before_migration) return false;
    const { schemas } = manifest;
    if (schemas === undefined) return true;
    if (schemas.store > this.#o.ownSchemas.store) return true;
    if (schemas.telemetry > this.#o.ownSchemas.telemetry) return true;
    return (
      migrationTestHook({ env: this.#o.env ?? process.env, releaseBuild: this.#o.releaseBuild })
        .length > 0
    );
  }

  async #applyNow(): Promise<void> {
    const layout = this.#o.layout;
    const version = this.#version;
    if (layout === undefined || version === null) {
      this.#giveUp();
      return;
    }
    const { logger } = this.#o;
    let journal: UpdateJournal;
    let applierExe: string;
    try {
      const busy = await readJournal(layout.journal);
      // Only a journal that is backed by a signed manifest can hold the way: a forged one with a
      // live pid would otherwise stop every update for good.
      if (
        busy.kind === 'ok' &&
        !FINAL_STEPS.includes(busy.journal.step) &&
        busy.journal.applierPid > 0 &&
        isAlive(busy.journal.applierPid) &&
        (await this.#trust(layout, busy.journal)).ok
      ) {
        throw new UpdateStop('swap_failed', 'another swap is under way', version);
      }
      const { staged, manifest, manifestBytes, signature } = await this.#verifyStaged(version);
      applierExe = staged.file;
      let backup: string | null = null;
      if (this.#needsBackup(manifest)) {
        const made = await this.#o.backup?.();
        if (made?.ok !== true) {
          throw new UpdateStop(
            'backup_failed',
            made === undefined ? 'this store cannot make a backup' : made.detail,
            version,
          );
        }
        backup = made.dir;
      }
      await rm(layout.stagingDir, { recursive: true, force: true });
      await mkdir(layout.stagingDir, { recursive: true, mode: 0o755 });
      await copyFile(staged.file, layout.stagingExe);
      await chmod(layout.stagingExe, 0o755);
      // The proof the journal is backed by (P8a): the manifest and its signature, beside the executable.
      await writeFile(join(layout.stagingDir, PROOF_MANIFEST), manifestBytes);
      await writeFile(join(layout.stagingDir, PROOF_SIGNATURE), signature);
      if ((await sha256OfFile(layout.stagingExe)) !== staged.asset.sha256) {
        throw new UpdateStop('sha256', 'the copy next to the executable does not match', version);
      }
      const now = this.#o.clock.now();
      journal = {
        v: 1,
        from: this.#o.version,
        to: version,
        sha256: staged.asset.sha256,
        manifestSha256: sha256Hex(manifestBytes),
        step: 'waiting',
        oldPid: this.#o.pid ?? process.pid,
        applierPid: 0,
        dataDir: this.#o.dataDir,
        exe: layout.exe,
        rollback: this.#o.settings.rollback,
        healthTimeoutMs: this.#o.settings.health_timeout,
        stableMs: this.#o.stableMs ?? STABLE_MS,
        fsRetry: this.#o.settings.apply.fs_retry,
        fsRetryTimeoutMs: this.#o.settings.apply.fs_retry_timeout,
        backup,
        reason: null,
        reported: false,
        startedAt: now,
        updatedAt: now,
      };
      await writeJournal(layout.journal, journal);
    } catch (error) {
      await this.#refused(error, version);
      return;
    }

    this.#tell('applying', version, null);
    try {
      await this.#o.launch(layout, applierExe);
    } catch (error) {
      logger.error({ err: error }, 'update: the applier could not be started');
      await rm(layout.journal, { force: true }).catch(() => undefined);
      await rm(layout.stagingDir, { recursive: true, force: true }).catch(() => undefined);
      await this.#refused(
        new UpdateStop('swap_failed', 'the applier could not be started', version),
        version,
      );
      return;
    }
    // The applier waits for this process to end; the clean stop leaves the attempts awaiting_resume.
    logger.info(
      { from: this.#o.version, to: version },
      'update: applier started; stopping the daemon',
    );
    await this.#o.shutdown();
  }

  /** The apply stopped before anything moved: what is told, and what is left for the next try. */
  async #refused(error: unknown, version: string): Promise<void> {
    const stop =
      error instanceof UpdateStop
        ? error
        : new UpdateStop(
            'swap_failed',
            error instanceof Error ? error.message : String(error),
            version,
          );
    const phase = phaseOf(stop.reason);
    this.#o.logger.warn(
      { reason: stop.reason, version, phase },
      `update ${phase}: ${stop.message}`,
    );
    this.#tell(phase, version, stop.reason);
    if (phase === 'rejected') {
      this.#o.situations.record('daemon.notice', {
        kind: 'update_rejected',
        subject: situationSubject(version),
        detail: stop.reason,
      });
      await this.#o.staging.drop(version);
      this.#o.forget(version);
      this.#version = null;
    } else {
      this.#o.situations.record('daemon.notice', {
        kind: 'update_failed',
        subject: situationSubject(version),
        detail: stop.reason,
      });
    }
    this.#giveUp();
  }

  /** A swap that ended in `rolled_back` or `failed` is not tried again by itself (a loop of rollbacks). */
  async #blocked(version: string): Promise<boolean> {
    const layout = this.#o.layout;
    if (layout === undefined || this.#allowed.has(version)) return false;
    const reading = await readJournal(layout.journal);
    if (reading.kind !== 'ok') return false;
    const { journal } = reading;
    return journal.to === version && (journal.step === 'rolled_back' || journal.step === 'failed');
  }

  // ---- how a swap ended --------------------------------------------------------------------

  /** Starts reading the journal: what a swap left, and what the one now under way is doing. */
  start(): void {
    if (this.#reporter !== undefined || this.#o.layout === undefined) return;
    this.#reporter = this.#report().catch((error: unknown) => {
      if (!this.#abort.signal.aborted && !(error instanceof Cancelled)) {
        this.#o.logger.warn({ err: error }, 'update: the journal of the swap could not be read');
      }
    });
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    this.#idle?.abort();
    this.#o.work?.release();
    await this.#reporter;
    await Promise.allSettled([...this.#loops]);
  }

  async #report(): Promise<void> {
    const layout = this.#o.layout;
    if (layout === undefined) return;
    for (;;) {
      const reading = await readJournal(layout.journal);
      if (reading.kind !== 'ok') return;
      const { journal } = reading;
      if (FINAL_STEPS.includes(journal.step)) {
        this.#last = {
          outcome:
            journal.step === 'committed'
              ? 'applied'
              : journal.step === 'rolled_back'
                ? 'rolled_back'
                : 'failed',
          version: journal.to,
          reason: journal.reason,
          at: new Date(journal.updatedAt).toISOString(),
        };
        if (!journal.reported && this.#mine(journal)) await this.#tellEnd(layout, journal);
        return;
      }
      // A swap is under way: this is the new daemon (or the old one that is about to go away).
      if (this.#state === 'applying') return;
      // A journal that asks for something is backed by a signed manifest, or it is not believed (P8a).
      const trust = await this.#trust(layout, journal);
      if (!trust.ok) {
        // The applier may have committed (and cleared the proof) since the journal was read: look again.
        const again = await readJournal(layout.journal);
        if (again.kind === 'ok' && again.journal.updatedAt !== journal.updatedAt) continue;
        this.#o.logger.warn(
          { step: journal.step, to: journal.to, detail: trust.detail },
          'update: the journal of a swap is not backed by a signed manifest; it is not followed',
        );
        this.#o.situations.record('daemon.notice', {
          kind: 'update_untrusted_journal',
          subject: situationSubject(journal.to),
          detail: trust.detail,
        });
        return;
      }
      await this.#o.clock.sleep(this.#o.reportPollMs ?? REPORT_POLL_MS, this.#abort.signal);
    }
  }

  async #trust(layout: InstallLayout, journal: UpdateJournal): Promise<JournalTrust> {
    return await checkJournalTrust({
      layout,
      journal,
      key: this.#o.key,
      platform: this.#o.platform,
    });
  }

  /** Whether this daemon is the one the journal's end is about (the other one is not here to tell). */
  #mine(journal: UpdateJournal): boolean {
    const current = this.#o.version;
    if (journal.step === 'committed') return current === journal.to;
    if (journal.step === 'rolled_back') return current === journal.from;
    return current === journal.to || current === journal.from;
  }

  async #tellEnd(layout: InstallLayout, journal: UpdateJournal): Promise<void> {
    const subject = situationSubject(journal.to);
    if (journal.step === 'committed') {
      this.#tell('applied', journal.to, null);
      this.#o.situations.record('daemon.notice', {
        kind: 'update_applied',
        subject,
        detail: situationSubject(journal.from),
      });
      // The copy in the staging of the data folder was applied: it is not offered again.
      await this.#o.staging.drop(journal.to);
      this.#o.forget(journal.to);
    } else if (journal.step === 'rolled_back') {
      this.#tell('rolled_back', journal.to, journal.reason);
      this.#o.situations.record('daemon.notice', {
        kind: 'update_rolled_back',
        subject,
        detail: journal.reason,
      });
    } else {
      this.#tell('failed', journal.to, journal.reason);
      this.#o.situations.record('daemon.notice', {
        kind: 'update_failed',
        subject,
        detail: journal.reason,
      });
    }
    await writeJournal(layout.journal, { ...journal, reported: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
