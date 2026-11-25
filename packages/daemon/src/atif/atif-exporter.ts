// SPDX-License-Identifier: MPL-2.0
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { sweepTemporaries, temporaryPathOf } from '@otheater/client/node';
import {
  NotFound,
  type Clock,
  type EventEnvelope,
  type PricingTable,
  type SecretVault,
  type Store,
} from '@otheater/core';
import {
  AtifTrajectorySchema,
  isTrajectoryEvent,
  type AtifExportContent,
  type AtifExportFailure,
  type AtifExportTrigger,
  type AtifExportUnit,
  type AtifTrajectory,
} from '@otheater/protocol';
import type { SituationSink } from '../situations.js';
import type { AtifSettings } from './atif-config.js';
import { buildAtifPlay, type AtifPlayTrajectories } from './atif-builder.js';
import { createMasker, vaultValues } from './atif-mask.js';

/**
 * The ATIF export of a play (Phase 8, P5; architecture 5.11, N219): reads the log and the
 * registries, folds them with {@link buildAtifPlay}, checks the result against the schema and
 * writes the files. [proposta] The log has no index by play on its port, so the events are read in
 * blocks from the start and filtered, as the trajectory service does. A file is written whole to a
 * temporary name and renamed, so a reader never meets half of one. Every file written is an
 * `atif.exported` event; a trigger that gave no file is an `atif.export_failed` event, and the
 * play is not touched either way.
 */

/** Events read from the log at a time. */
const SCAN_BLOCK = 1000;

/** The events of the play the export reads besides the trajectory ones. */
function isExportEvent(type: string): boolean {
  return isTrajectoryEvent(type) || type === 'chat.director_reply' || type.startsWith('decision.');
}

/** The shape of the temporary of an export: `<file>.<pid>.tmp`. */
const ATIF_TEMPORARY_SHAPE = { hexLength: 0 } as const;

/**
 * Writes one file of an export atomically (a temporary, then a rename) and removes the orphans a
 * killed process left (N306).
 */
export async function writeExportFile(dir: string, path: string, text: string): Promise<void> {
  const temporary = temporaryPathOf(path, ATIF_TEMPORARY_SHAPE);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new AtifExportError('write_failed', failureDetail(error));
  }
  // N306: a process killed between the write and the rename leaves `<file>.<pid>.tmp`.
  await sweepTemporaries(path, ATIF_TEMPORARY_SHAPE);
}

/** An export that did not produce what was asked; `reason` is the one of `atif.export_failed`. */
export class AtifExportError extends Error {
  constructor(
    readonly reason: AtifExportFailure,
    readonly detail: string | null,
  ) {
    super(detail === null ? reason : `${reason}: ${detail}`);
    this.name = 'AtifExportError';
  }
}

export interface AtifExporterDeps {
  readonly store: Store;
  readonly clock: Clock;
  /** The vault whose values are masked; absent: only the shapes of keys are. */
  readonly vault?: SecretVault | undefined;
  /** The version of the daemon: the version of the Director's agent. */
  readonly version: string;
  readonly dataDir: string;
  readonly settings: () => AtifSettings;
  readonly pricing: () => PricingTable;
  readonly situations: SituationSink;
}

export interface AtifExportRequest {
  /** Default `atif.export.unit`. */
  readonly unit?: AtifExportUnit | undefined;
  /** Default `atif.export.content`. */
  readonly content?: AtifExportContent | undefined;
  /** Default `atif.export.dir`; relative to the data folder, or absolute. */
  readonly dir?: string | undefined;
  /** Who asked: the trigger of the config, or `manual` (the command). */
  readonly on: AtifExportTrigger;
  /** With the units `attempt` and `play_files`: only this attempt's file (and the root, in `play_files`). */
  readonly attemptId?: string | undefined;
}

export interface AtifExportedFile {
  readonly unit: 'play' | 'attempt';
  readonly attemptId: string | null;
  /** Absolute. */
  readonly path: string;
  readonly bytes: number;
  readonly steps: number;
  readonly attempts: number;
}

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_');
export const atifPlayFileName = (playId: string): string => `${safeName(playId)}.atif.json`;
const attemptFile = (playId: string, attemptId: string): string =>
  `${safeName(playId)}.${safeName(attemptId)}.atif.json`;

function failureDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}

export class AtifExporter {
  readonly #deps: AtifExporterDeps;

  constructor(deps: AtifExporterDeps) {
    this.#deps = deps;
  }

  /** The folder the files of this request go to. */
  directoryOf(request: Pick<AtifExportRequest, 'dir'> = {}): string {
    const dir = request.dir ?? this.#deps.settings().dir;
    return isAbsolute(dir) ? dir : join(this.#deps.dataDir, dir);
  }

  /**
   * The trajectory of a play as the route answers it: the Director's, with every attempt embedded;
   * with `attemptId`, that attempt's alone. Writes nothing. `NotFound` for an unknown play or attempt.
   */
  async trajectory(
    playId: string,
    options: { readonly content?: AtifExportContent; readonly attemptId?: string } = {},
  ): Promise<AtifTrajectory> {
    const content = options.content ?? this.#deps.settings().content;
    const built = await this.#build(playId, content, (id) => ({ trajectory_id: id }));
    if (options.attemptId !== undefined) {
      const found = built.attempts.get(options.attemptId);
      if (found === undefined) {
        throw new NotFound(`The play "${playId}" has no attempt "${options.attemptId}"`);
      }
      return this.#checked(found);
    }
    return this.#checked(embedded(built));
  }

  /** Writes the files of a play and says so in the log. Rejects with {@link AtifExportError} (also written). */
  async export(playId: string, request: AtifExportRequest): Promise<readonly AtifExportedFile[]> {
    const settings = this.#deps.settings();
    const unit = request.unit ?? settings.unit;
    const content = request.content ?? settings.content;
    let scenarioId: string | undefined;
    try {
      const refOf =
        unit === 'play_files'
          ? (id: string) => ({ trajectory_path: attemptFile(playId, id) })
          : (id: string) => ({ trajectory_id: id });
      const built = await this.#build(playId, content, refOf);
      scenarioId = built.root.extra?.otheater?.scenarioId ?? undefined;
      if (request.attemptId !== undefined && !built.attempts.has(request.attemptId)) {
        throw new AtifExportError('attempt_not_found', null);
      }
      const dir = this.directoryOf(request);
      const files: AtifExportedFile[] = [];
      const write = async (
        name: string,
        trajectory: AtifTrajectory,
        kind: 'play' | 'attempt',
        attemptId: string | null,
        attempts: number,
      ): Promise<void> => {
        const text = `${JSON.stringify(this.#checked(trajectory), null, 2)}\n`;
        const path = join(dir, name);
        await writeExportFile(dir, path, text);
        const file: AtifExportedFile = {
          unit: kind,
          attemptId,
          path,
          bytes: Buffer.byteLength(text),
          steps: trajectory.steps.length,
          attempts,
        };
        files.push(file);
        this.#deps.situations.record(
          'atif.exported',
          {
            unit: kind,
            attemptId,
            on: request.on,
            content,
            path: this.#eventPath(path),
            bytes: file.bytes,
            steps: file.steps,
            attempts,
          },
          {
            ...(scenarioId === undefined ? {} : { scenarioId }),
            playId,
            ...(attemptId === null ? {} : { attemptId }),
          },
        );
      };
      const wanted = (id: string): boolean =>
        request.attemptId === undefined || request.attemptId === id;
      if (unit === 'play') {
        await write(atifPlayFileName(playId), embedded(built), 'play', null, built.attempts.size);
      } else {
        if (unit === 'play_files') {
          await write(atifPlayFileName(playId), built.root, 'play', null, built.attempts.size);
        }
        for (const [id, trajectory] of built.attempts) {
          if (wanted(id)) await write(attemptFile(playId, id), trajectory, 'attempt', id, 0);
        }
      }
      return files;
    } catch (error) {
      const failure =
        error instanceof AtifExportError
          ? error
          : error instanceof NotFound
            ? new AtifExportError('play_not_found', null)
            : new AtifExportError('build_failed', failureDetail(error));
      this.#deps.situations.record(
        'atif.export_failed',
        {
          unit,
          attemptId: request.attemptId ?? null,
          on: request.on,
          reason: failure.reason,
          detail: failure.detail === null ? null : failure.detail.slice(0, 512),
        },
        {
          ...(scenarioId === undefined ? {} : { scenarioId }),
          ...(failure.reason === 'play_not_found' ? {} : { playId }),
        },
      );
      throw failure;
    }
  }

  /** The play and everything the fold reads, then the fold. */
  async #build(
    playId: string,
    content: AtifExportContent,
    refOf: (attemptId: string) => { trajectory_id?: string; trajectory_path?: string },
  ): Promise<AtifPlayTrajectories> {
    const { store, clock } = this.#deps;
    const play = await store.plays.get(playId);
    if (play === undefined) throw new NotFound(`There is no play "${playId}"`);
    const mask = createMasker(await this.#secretValues(content));
    const [events, attempts, demands, sessions, usage] = await Promise.all([
      this.#eventsOf(playId),
      store.attempts.list().then((all) => all.filter((attempt) => attempt.playId === playId)),
      store.demands.list({ playId }),
      store.sessions.list(),
      store.usage.list({ playId }),
    ]);
    return buildAtifPlay(
      { play, events, attempts, demands, sessions, usage },
      {
        content,
        exportedAt: clock.now(),
        version: this.#deps.version,
        pricing: this.#deps.pricing(),
        mask,
        refOf,
      },
    );
  }

  /**
   * The values of the vault, which both contents mask. `full` fails closed: with the vault locked
   * or unreadable nothing is written. `redacted` writes no text, so the values are a second net
   * there (the ids and the names still pass through it) and a vault it cannot read is not a failure.
   */
  async #secretValues(content: AtifExportContent): Promise<string[]> {
    const { vault } = this.#deps;
    if (vault === undefined) return [];
    try {
      return await vaultValues(vault);
    } catch (error) {
      if (content === 'redacted') return [];
      throw new AtifExportError('vault_unavailable', failureDetail(error));
    }
  }

  async #eventsOf(playId: string): Promise<EventEnvelope[]> {
    const { events } = this.#deps.store;
    const found: EventEnvelope[] = [];
    let cursor = 0;
    for (;;) {
      const block = await events.readFrom(cursor, SCAN_BLOCK);
      for (const event of block) {
        cursor = event.id;
        if (isExportEvent(event.type) && belongsTo(event, playId)) found.push(event);
      }
      if (block.length < SCAN_BLOCK) return found;
    }
  }

  #checked(trajectory: AtifTrajectory): AtifTrajectory {
    const parsed = AtifTrajectorySchema.safeParse(trajectory);
    if (parsed.success) return trajectory;
    // The path and the code only: the message of an issue can quote the value.
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : `${issue.path.join('.')} (${issue.code})`;
    throw new AtifExportError('invalid_trajectory', where.slice(0, 500));
  }

  /** Relative to the data folder when the file is inside it, else absolute. */
  #eventPath(path: string): string {
    const inside = relative(this.#deps.dataDir, path);
    return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? path : inside;
  }
}

/** The root with every attempt in `subagent_trajectories`, in the order they began. */
function embedded(built: AtifPlayTrajectories): AtifTrajectory {
  return built.attempts.size === 0
    ? built.root
    : { ...built.root, subagent_trajectories: [...built.attempts.values()] };
}

/** An event of the play: the envelope says so, or (the Director's reply) its payload does. */
function belongsTo(event: EventEnvelope, playId: string): boolean {
  if (event.playId === playId) return true;
  const payload = event.payload as { readonly playId?: unknown } | null;
  return event.type === 'chat.director_reply' && payload?.playId === playId;
}
