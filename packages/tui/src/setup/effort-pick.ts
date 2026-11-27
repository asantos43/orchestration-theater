// SPDX-License-Identifier: MPL-2.0
import type { TFunction } from 'i18next';
import { rowEffortChoices, type ExecutorRow } from './executor-list.js';

/**
 * The list of efforts of a row of the table (N335, the owner on 2026-11-27): opened on the cell
 * Esforço, it shows the efforts the model accepts; ↑/↓ walk it, Enter chooses, Esc closes without
 * changing. [proposta] An effort another row of the same model already holds is shown dimmed and
 * Enter does not take it (two rows would be one Executor). This module is pure.
 */

export interface EffortChoice {
  /** `null`: no effort (a row the preset gives with none). */
  readonly effort: string | null;
  /** Another row of the model holds it. */
  readonly taken: boolean;
}

export interface EffortPick {
  /** The row of the table the effort is for. */
  readonly row: number;
  /** How the title calls the model. */
  readonly name: string;
  readonly current: string | null;
  readonly choices: readonly EffortChoice[];
  readonly cursor: number;
}

/** The list for the row, with the cursor on its effort now; `undefined` for a row with nothing to choose. */
export function effortPickStart(
  rows: readonly ExecutorRow[],
  index: number,
): EffortPick | undefined {
  const row = rows[index];
  if (row === undefined || row.registered) return undefined;
  const choices = rowEffortChoices(rows, index);
  if (choices.length === 0) return undefined;
  return {
    row: index,
    name: row.model,
    current: row.effort,
    choices,
    cursor: Math.max(
      0,
      choices.findIndex((choice) => choice.effort === row.effort),
    ),
  };
}

export interface EffortPickStep {
  readonly pick: EffortPick;
  /** `confirm`: Enter on another effort the row can take; `cancel`: Esc, or Enter on the one it has. */
  readonly done?: 'confirm' | 'cancel';
}

export function effortPickKey(pick: EffortPick, combo: string | undefined): EffortPickStep {
  switch (combo) {
    case 'Esc':
      return { pick, done: 'cancel' };
    case 'Enter': {
      const choice = pick.choices[pick.cursor];
      if (choice === undefined || choice.effort === pick.current) return { pick, done: 'cancel' };
      // An effort another row holds is not taken: the list stays open.
      return choice.taken ? { pick } : { pick, done: 'confirm' };
    }
    case 'Up':
      return { pick: { ...pick, cursor: Math.max(0, pick.cursor - 1) } };
    case 'Down':
      return { pick: { ...pick, cursor: Math.min(pick.choices.length - 1, pick.cursor + 1) } };
    default:
      return { pick };
  }
}

/** The effort the list would give now. */
export function effortOfPick(pick: EffortPick): string | null {
  return pick.choices[pick.cursor]?.effort ?? pick.current;
}

export interface EffortPickLine {
  readonly key: string;
  readonly text: string;
  readonly selected?: boolean;
  readonly dim?: boolean;
  readonly tone?: 'accent';
}

export function effortPickLines(pick: EffortPick, t: TFunction): readonly EffortPickLine[] {
  const lines: EffortPickLine[] = [
    { key: 'ep.title', text: t('setup.effort.title', { model: pick.name }), tone: 'accent' },
  ];
  pick.choices.forEach((choice, index) => {
    const label = choice.effort ?? t('setup.effort.none');
    const marks = [
      ...(choice.effort === pick.current ? [t('setup.effort.current')] : []),
      ...(choice.taken ? [t('setup.effort.taken')] : []),
    ];
    lines.push({
      key: `ep.${choice.effort ?? '-'}`,
      text: `${label}${marks.length === 0 ? '' : `  (${marks.join(', ')})`}`,
      selected: index === pick.cursor,
      ...(choice.taken ? { dim: true } : {}),
    });
  });
  lines.push({ key: 'ep.keys', text: t('setup.effort.keys'), dim: true });
  return lines;
}
