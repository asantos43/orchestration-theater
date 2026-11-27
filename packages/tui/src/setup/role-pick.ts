// SPDX-License-Identifier: MPL-2.0
import { SetupRolePlacementSchema, type SetupRolePlacement } from '@otheater/protocol';
import type { TFunction } from 'i18next';

/**
 * The roles of an Executor, as a multi-select of the seven roles (N333, item 4; N335, the owner on
 * 2026-11-27). It opens in two places: in the table of the step Executors, on the cell Papéis of a
 * row, and in the review with P, for any Executor of the plan. The roles it opens with are the
 * Executor's own (checked); what is left checked is what the Executor serves (`exact`): one taken
 * out leaves that list, one added enters at the end of it. This module is pure: what each key does
 * and what it draws.
 */

export type PickRole = SetupRolePlacement['roles'][number];

/** The seven roles, in the order of the registry. */
export const ROLE_IDS: readonly PickRole[] = SetupRolePlacementSchema.shape.roles.element.options;

/** What the roles are for: an Executor of the plan at the review, or a row of the table. */
export type RolePickTarget =
  | { readonly kind: 'review'; readonly executorId: string }
  | { readonly kind: 'row'; readonly index: number };

export interface RolePick {
  readonly target: RolePickTarget;
  /** How the title calls the Executor. */
  readonly name: string;
  /** The roles the Executor had when the list opened: Enter with the same set leaves it as it was. */
  readonly initial: readonly PickRole[];
  readonly checked: readonly PickRole[];
  readonly cursor: number;
}

/** The list opens with `initial` checked, in the order of the registry. */
export function rolePickStart(
  target: RolePickTarget,
  name: string,
  initial: readonly PickRole[] = [],
): RolePick {
  const checked = ROLE_IDS.filter((role) => initial.includes(role));
  return { target, name, initial: checked, checked, cursor: 0 };
}

/** The checked roles are not the ones the list opened with. */
export function rolePickChanged(pick: RolePick): boolean {
  return (
    pick.checked.length !== pick.initial.length ||
    pick.checked.some((role) => !pick.initial.includes(role))
  );
}

export interface RolePickStep {
  readonly pick: RolePick;
  /** `confirm`: Enter with the roles changed (even with none left); `cancel`: Esc, or Enter with no change. */
  readonly done?: 'confirm' | 'cancel';
}

/** One key: ↑/↓ walk the roles, Space checks or unchecks, Enter takes the choice, Esc leaves it. */
export function rolePickKey(pick: RolePick, combo: string | undefined): RolePickStep {
  const last = ROLE_IDS.length - 1;
  switch (combo) {
    case 'Esc':
      return { pick, done: 'cancel' };
    case 'Enter':
      return { pick, done: rolePickChanged(pick) ? 'confirm' : 'cancel' };
    case 'Up':
      return { pick: { ...pick, cursor: Math.max(0, pick.cursor - 1) } };
    case 'Down':
      return { pick: { ...pick, cursor: Math.min(last, pick.cursor + 1) } };
    case 'Space': {
      const role = ROLE_IDS[pick.cursor];
      if (role === undefined) return { pick };
      const checked = pick.checked.includes(role)
        ? pick.checked.filter((id) => id !== role)
        : ROLE_IDS.filter((id) => id === role || pick.checked.includes(id));
      return { pick: { ...pick, checked } };
    }
    default:
      return { pick };
  }
}

export interface RolePickLine {
  readonly key: string;
  readonly text: string;
  readonly selected?: boolean;
  readonly dim?: boolean;
  readonly tone?: 'accent';
}

/** The lines of the list. */
export function rolePickLines(pick: RolePick, t: TFunction): readonly RolePickLine[] {
  const lines: RolePickLine[] = [
    { key: 'rp.title', text: t('setup.roles.title', { executor: pick.name }), tone: 'accent' },
  ];
  ROLE_IDS.forEach((role, index) => {
    lines.push({
      key: `rp.${role}`,
      text: `${pick.checked.includes(role) ? '[x]' : '[ ]'} ${role}`,
      selected: index === pick.cursor,
    });
  });
  lines.push({ key: 'rp.keys', text: t('setup.roles.keys'), dim: true });
  return lines;
}
