// SPDX-License-Identifier: MPL-2.0
import {
  buildTrajectory,
  type ApiDemandDiff,
  type ApiPlay,
  type Trajectory,
  type TrajectoryEntry,
  type TrajectoryEvent,
} from '@otheater/protocol';
import type { DirectTrajectorySubject } from '@otheater/client';
import { wrapText } from '../../layout/text.js';
import type { TrajectoryFollowMode, TrajectoryOpenMode } from '../../settings.js';

/**
 * What the Trajectories tab shows and which of its sections are open (P14 of docs/18, architecture
 * 5.11). Pure: the stores, the screen and the tests all go through these functions. [proposta]
 */

/** The play the tab follows: the most recently updated one of the scenario (the id breaks a tie). */
export function latestPlayId(
  plays: Readonly<Record<string, ApiPlay>>,
  scenarioId: string | undefined,
): string | undefined {
  if (scenarioId === undefined) return undefined;
  let found: ApiPlay | undefined;
  for (const play of Object.values(plays)) {
    if (play.scenarioId !== scenarioId) continue;
    if (
      found === undefined ||
      play.updatedAt > found.updatedAt ||
      (play.updatedAt === found.updatedAt && play.id > found.id)
    ) {
      found = play;
    }
  }
  return found?.id;
}

/** What the tab follows: a play, or a direct session of the scenario (P27 of docs/18). */
export interface FollowedSubject {
  readonly kind: 'play' | 'direct';
  /** The play id, or the direct session id: the key the trajectory is held under. */
  readonly id: string;
}

/** The direct session of the scenario the tab follows: the one that moved last (the id breaks a tie). */
export function latestDirectId(
  direct: Readonly<Record<string, DirectTrajectorySubject>>,
  scenarioId: string | undefined,
): string | undefined {
  if (scenarioId === undefined) return undefined;
  let found: DirectTrajectorySubject | undefined;
  for (const session of Object.values(direct)) {
    if (session.scenarioId !== scenarioId) continue;
    if (
      found === undefined ||
      session.at > found.at ||
      (session.at === found.at && session.sessionId > found.sessionId)
    ) {
      found = session;
    }
  }
  return found?.sessionId;
}

/**
 * What the tab follows, by `ui.trajectories.follow` [proposta]: `play` is the latest play only;
 * `direct` is the latest direct session, or the latest play when the scenario has none; `latest`
 * (the default) is whichever of the two moved last, the play on a tie.
 */
export function followedSubject(
  plays: Readonly<Record<string, ApiPlay>>,
  direct: Readonly<Record<string, DirectTrajectorySubject>>,
  scenarioId: string | undefined,
  follow: TrajectoryFollowMode,
): FollowedSubject | undefined {
  const playId = latestPlayId(plays, scenarioId);
  const directId = follow === 'play' ? undefined : latestDirectId(direct, scenarioId);
  if (directId === undefined)
    return playId === undefined ? undefined : { kind: 'play', id: playId };
  if (playId === undefined || follow === 'direct') return { kind: 'direct', id: directId };
  const play = plays[playId];
  const session = direct[directId];
  if (play !== undefined && session !== undefined && session.at > play.updatedAt) {
    return { kind: 'direct', id: directId };
  }
  return { kind: 'play', id: playId };
}

const built = new WeakMap<readonly TrajectoryEvent[], Map<string, Trajectory>>();

/** The trajectory of a play from its events; kept per list of events, so a render does not fold twice. */
export function trajectoryOf(playId: string, events: readonly TrajectoryEvent[]): Trajectory {
  let byPlay = built.get(events);
  if (byPlay === undefined) {
    byPlay = new Map();
    built.set(events, byPlay);
  }
  let trajectory = byPlay.get(playId);
  if (trajectory === undefined) {
    trajectory = buildTrajectory(playId, events);
    byPlay.set(playId, trajectory);
  }
  return trajectory;
}

// The ids are short: the layout keeps them in `collapsedSections` (64 characters at most) and
// they are numbered by position, not by the id of the attempt.
export function attemptSectionId(attempt: number): string {
  return `trajectories.a${String(attempt)}`;
}

export function turnSectionId(attempt: number, turn: number): string {
  return `trajectories.a${String(attempt)}.t${String(turn)}`;
}

export function diffSectionId(attempt: number): string {
  return `trajectories.a${String(attempt)}.diff`;
}

export const TRANSITIONS_SECTION_ID = 'trajectories.transitions';

/**
 * Whether a section starts folded, by `ui.trajectories.open`: `none` folds everything, `all`
 * folds nothing, `last` opens only the last attempt, its last turn and its diff. What the person
 * does with Enter is kept apart from this (it flips the default).
 */
export function startsFolded(
  id: string,
  mode: TrajectoryOpenMode,
  trajectory: Trajectory,
): boolean {
  if (mode === 'all') return false;
  if (mode === 'none') return true;
  const lastAttempt = trajectory.attempts.length;
  const last = trajectory.attempts[lastAttempt - 1];
  if (last === undefined) return true;
  if (id === attemptSectionId(lastAttempt) || id === diffSectionId(lastAttempt)) return false;
  return id !== turnSectionId(lastAttempt, last.turns.length);
}

/** Folded now: the default, flipped by the sections the person toggled (`LayoutStore.collapsedSections`). */
export function isFolded(
  id: string,
  mode: TrajectoryOpenMode,
  trajectory: Trajectory,
  toggled: ReadonlySet<string>,
): boolean {
  return startsFolded(id, mode, trajectory) !== toggled.has(id);
}

/** The folded set the `Section` components take: every section of the tab, resolved. */
export function foldedSet(
  trajectory: Trajectory | undefined,
  mode: TrajectoryOpenMode,
  toggled: ReadonlySet<string>,
): ReadonlySet<string> {
  const folded = new Set<string>();
  if (trajectory === undefined) return folded;
  for (const id of allSectionIds(trajectory)) {
    if (isFolded(id, mode, trajectory, toggled)) folded.add(id);
  }
  return folded;
}

/** For each attempt (1-based) that owns the diff of its demand: the demand. The last attempt of a demand owns it. */
export function diffOwners(trajectory: Trajectory): Map<number, string> {
  const owners = new Map<number, string>();
  const lastOf = new Map<string, number>();
  trajectory.attempts.forEach((attempt, index) => {
    if (attempt.demandId !== undefined) lastOf.set(attempt.demandId, index + 1);
  });
  for (const [demandId, attempt] of lastOf) owners.set(attempt, demandId);
  return owners;
}

function allSectionIds(trajectory: Trajectory): string[] {
  const owners = diffOwners(trajectory);
  const ids: string[] = [];
  trajectory.attempts.forEach((attempt, index) => {
    const number = index + 1;
    ids.push(attemptSectionId(number));
    for (const turn of attempt.turns) ids.push(turnSectionId(number, turn.index));
    if (owners.has(number)) ids.push(diffSectionId(number));
  });
  if (trajectory.transitions.length > 0) ids.push(TRANSITIONS_SECTION_ID);
  return ids;
}

/** The sections the cursor can walk, top to bottom: the ones inside a folded attempt are not on screen. */
export function visibleSections(
  trajectory: Trajectory | undefined,
  mode: TrajectoryOpenMode,
  toggled: ReadonlySet<string>,
): string[] {
  if (trajectory === undefined) return [];
  const owners = diffOwners(trajectory);
  const ids: string[] = [];
  trajectory.attempts.forEach((attempt, index) => {
    const number = index + 1;
    ids.push(attemptSectionId(number));
    if (isFolded(attemptSectionId(number), mode, trajectory, toggled)) return;
    for (const turn of attempt.turns) ids.push(turnSectionId(number, turn.index));
    if (owners.has(number)) ids.push(diffSectionId(number));
  });
  if (trajectory.transitions.length > 0) ids.push(TRANSITIONS_SECTION_ID);
  return ids;
}

/** The diffs the screen must ask the daemon for: the open diff sections whose diff nobody read yet. */
export function wantedDiffs(
  trajectory: Trajectory | undefined,
  mode: TrajectoryOpenMode,
  toggled: ReadonlySet<string>,
): string[] {
  if (trajectory === undefined) return [];
  const wanted: string[] = [];
  for (const [attempt, demandId] of diffOwners(trajectory)) {
    if (isFolded(attemptSectionId(attempt), mode, trajectory, toggled)) continue;
    if (isFolded(diffSectionId(attempt), mode, trajectory, toggled)) continue;
    wanted.push(demandId);
  }
  return wanted;
}

export interface DiffLine {
  readonly text: string;
  readonly kind: 'add' | 'remove' | 'hunk' | 'meta' | 'context';
}

export function diffLineKind(line: string): DiffLine['kind'] {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

/** The first `limit` lines of a diff, each with its kind, and how many were left out. */
export function diffLines(
  diff: ApiDemandDiff['diff'],
  limit: number,
): { readonly lines: DiffLine[]; readonly hidden: number } {
  const all = diff === '' ? [] : diff.replace(/\n$/, '').split('\n');
  const shown = all.slice(0, limit).map((text) => ({ text, kind: diffLineKind(text) }));
  return { lines: shown, hidden: Math.max(0, all.length - limit) };
}

/** A line of the screen: the text, and how to paint it. */
export interface EntryLine {
  readonly text: string;
  readonly tone: 'normal' | 'dim' | 'ok' | 'warn' | 'error';
}

/** The words an entry needs, taken from the `trajectories.entry.*` texts of the catalog. */
export type Say = (key: string, values?: Readonly<Record<string, string | number>>) => string;

/** How many lines of a message, a thought or a terminal output one step shows before it says "more". */
export const ENTRY_MAX_LINES = 8;

function clipped(text: string, width: number, say: Say, prefix: string): EntryLine[] {
  const wrapped = wrapText(text.trim(), Math.max(1, width - prefix.length));
  const shown = wrapped.slice(0, ENTRY_MAX_LINES);
  const lines = shown.map((line, index): EntryLine => ({
    text: `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`,
    tone: 'normal',
  }));
  if (wrapped.length > shown.length) {
    lines.push({
      text: `${' '.repeat(prefix.length)}${say('trajectories.more', { count: wrapped.length - shown.length })}`,
      tone: 'dim',
    });
  }
  return lines;
}

/** The lines one entry of a turn takes (the screen cuts each to its width). */
export function entryLines(entry: TrajectoryEntry, width: number, say: Say): EntryLine[] {
  switch (entry.kind) {
    case 'message':
      return clipped(entry.text, width, say, `${say('trajectories.entry.message')} `);
    case 'prompt':
      return clipped(
        entry.text,
        width,
        say,
        `${say(entry.command ? 'trajectories.entry.command' : 'trajectories.entry.prompt')} `,
      );
    case 'thought':
      return clipped(entry.text, width, say, `${say('trajectories.entry.thought')} `).map(
        (line) => ({ ...line, tone: 'dim' }),
      );
    case 'terminal':
      return clipped(entry.text, width, say, `${say('trajectories.entry.terminal')} `).map(
        (line) => ({ ...line, tone: 'dim' }),
      );
    case 'tool_call': {
      const where = entry.paths.length === 0 ? '' : ` ${entry.paths.join(', ')}`;
      return [
        {
          text: `${say('trajectories.entry.toolCall')} ${entry.title} [${entry.toolKind}] ${entry.status}${where}`,
          tone: entry.status === 'failed' ? 'error' : 'normal',
        },
      ];
    }
    case 'tool': {
      const result =
        entry.outcome === undefined
          ? say('trajectories.entry.running')
          : [
              entry.outcome,
              entry.exitCode === undefined || entry.exitCode === null
                ? undefined
                : `exit ${String(entry.exitCode)}`,
              entry.durationMs === undefined ? undefined : `${String(entry.durationMs)} ms`,
            ]
              .filter((part) => part !== undefined)
              .join(', ');
      const failed = entry.outcome !== undefined && entry.outcome !== 'ok';
      return [
        {
          text: `${say('trajectories.entry.tool')} ${entry.tool} ${entry.summary} -> ${result}`,
          tone: failed ? 'error' : 'normal',
        },
      ];
    }
    case 'permission': {
      const answer = entry.answer ?? say('trajectories.entry.waiting');
      const detail = [entry.rule, entry.reason].filter((part) => part !== undefined).join(', ');
      const where = entry.paths.length === 0 ? '' : ` ${entry.paths.join(', ')}`;
      return [
        {
          text: `${say('trajectories.entry.permission')} ${entry.tool}${where} -> ${answer}${detail === '' ? '' : ` (${detail})`}`,
          tone: entry.answer === 'allow' ? 'ok' : 'warn',
        },
      ];
    }
    case 'plan':
      return [
        {
          text: `${say('trajectories.entry.plan')} ${entry.entries.map((item) => `[${item.status}] ${item.content}`).join(' | ')}`,
          tone: 'normal',
        },
      ];
  }
}
