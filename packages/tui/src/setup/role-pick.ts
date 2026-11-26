// SPDX-License-Identifier: MPL-2.0
import { SetupRolePlacementSchema, type SetupRolePlacement } from '@otheater/protocol';
import type { TFunction } from 'i18next';

/**
 * The roles of an Executor the preset left without one (N333, item 4; the owner on 2026-11-26):
 * a multi-select of the seven roles, opened in the review with P. The Executor enters at the end of
 * the list of each role checked. This module is pure: what each key does and what it draws.
 */

export type PickRole = SetupRolePlacement['roles'][number];

/** The seven roles, in the order of the registry. */
export const ROLE_IDS: readonly PickRole[] = SetupRolePlacementSchema.shape.roles.element.options;

export interface RolePick {
  /** The Executor of the plan the roles are for. */
  readonly executorId: string;
  readonly checked: readonly PickRole[];
  readonly cursor: number;
}

export function rolePickStart(executorId: string): RolePick {
  return { executorId, checked: [], cursor: 0 };
}

export interface RolePickStep {
  readonly pick: RolePick;
  /** `confirm`: Enter took at least one role; `cancel`: Esc, or Enter with none checked. */
  readonly done?: 'confirm' | 'cancel';
}

/** One key: ↑/↓ walk the roles, Space checks or unchecks, Enter takes the choice, Esc leaves it. */
export function rolePickKey(pick: RolePick, combo: string | undefined): RolePickStep {
  const last = ROLE_IDS.length - 1;
  switch (combo) {
    case 'Esc':
      return { pick, done: 'cancel' };
    case 'Enter':
      return { pick, done: pick.checked.length === 0 ? 'cancel' : 'confirm' };
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

/** The lines of the list; `name` is how the review calls the Executor. */
export function rolePickLines(pick: RolePick, name: string, t: TFunction): readonly RolePickLine[] {
  const lines: RolePickLine[] = [
    { key: 'rp.title', text: t('setup.roles.title', { executor: name }), tone: 'accent' },
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
