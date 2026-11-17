// SPDX-License-Identifier: MPL-2.0
import { reportDuplicates, type ProblemCollector } from './problems.js';

/**
 * The roles of version 1 (architecture 5.3, 5.4, 5.20). `director` coordinates and talks to the
 * Producer; `consultant` is the strong Actor of the generic chat; the other five are the roles of
 * the play and of `task.define`.
 */
export const ROLE_IDS = [
  'director',
  'consultant',
  'author',
  'reviewer',
  'scriptwriter',
  'actor',
  'critic',
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** Roles that run as an Executor (everything but the Director): the ones with the common tools. */
export const EXECUTOR_ROLE_IDS = [
  'consultant',
  'author',
  'reviewer',
  'scriptwriter',
  'actor',
  'critic',
] as const satisfies readonly RoleId[];

/** Pattern of a role id: lowercase snake case. */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * A role of the registry. The delivery schema, the prompt and the judgement points of each role
 * (architecture 5.18, "Registros") join this entry in the steps that build them.
 */
export interface RoleDefinition {
  readonly id: string;
  /** One line in English: what the role does (architecture 5.4, "Fronteira de cada papel"). */
  readonly summary: string;
}

export const OFFICIAL_ROLES: readonly RoleDefinition[] = [
  { id: 'director', summary: 'Coordinates, asks the Producer and classifies the critique' },
  { id: 'consultant', summary: 'Strong Actor the chat Director consults for hard questions' },
  { id: 'author', summary: 'Turns the need into a plan and reviews every script' },
  { id: 'reviewer', summary: 'Checks the plan against the need and judges its assumptions' },
  { id: 'scriptwriter', summary: 'Splits the plan into ready demands with contracts' },
  { id: 'actor', summary: 'Writes the code that meets one ready demand' },
  { id: 'critic', summary: 'Evaluates the integrated work against the plan and the script' },
];

export function validateRoles(roles: readonly RoleDefinition[], collector: ProblemCollector): void {
  reportDuplicates(
    collector,
    roles.map((role) => role.id),
    'Role',
  );
  for (const role of roles) {
    if (!ROLE_ID_PATTERN.test(role.id)) {
      collector.report(role.id, 'invalid_name', `Role id "${role.id}" is not lowercase snake case`);
    }
  }
}
