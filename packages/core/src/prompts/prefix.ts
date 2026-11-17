// SPDX-License-Identifier: MPL-2.0
import { formatInTimezone } from '../directives/validity.js';
import type { DirectiveRecord } from '../ports/directives.js';
import type { ToolDefinition } from '../registries/tools.js';
import { toolsOfRole } from './validate.js';

/**
 * What the prefix of a session is made of. Everything is already resolved by the caller, so
 * `assemblePrefix` is a pure function of this value.
 */
export interface PrefixInput {
  /** The role the session runs as (an id of the role registry). */
  readonly role: string;
  /** The text the `PromptSource` gave for the role. */
  readonly rolePrompt: string;
  /** The tool registry's entries (`registries.tools.list()`); the role's own are picked here. */
  readonly tools: readonly ToolDefinition[];
  /** Rules of the project (the repository's own instructions), already read; optional. */
  readonly projectRules?: string | undefined;
  /**
   * The orders in force for the scenario (`DirectiveRegistry.inForce`; the suspended globals are
   * already out). Only `instruction` orders that reach the role go into the text: a `rule` is
   * applied in code and a `suspension` already acted on the list (architecture 5.17).
   */
  readonly directives?: readonly DirectiveRecord[] | undefined;
  /** The contract(s) of the work, rendered by the caller (the demand's, for an Actor); optional. */
  readonly contract?: string | undefined;
}

const ORDERS_INTRO =
  'These are standing orders from the Producer. They stay in force until revoked. ' +
  'Follow them. When a local order conflicts with a global one, the local order prevails.';

const TOOLS_INTRO = 'These are the only framework tools you can call:';

const EFFECT_NOTE: Readonly<Record<ToolDefinition['effect'], string>> = {
  none: '',
  worktree: ' (changes your worktree)',
  external_write: ' (acts outside the worktree)',
};

/**
 * One order as a list item; later lines of a multi-line text are indented under it. [proposta] An
 * order that ends says so (`- O3 (until 2026-11-20 18:00 America/Sao_Paulo): text`), in its own
 * time zone, so the Executor knows the order is temporary; one with no end shows nothing.
 */
function orderItem(order: DirectiveRecord): string {
  const [first = '', ...rest] = order.text.trim().split('\n');
  const until =
    order.endsAt === null
      ? ''
      : ` (until ${formatInTimezone(order.endsAt, order.timezone)} ${order.timezone})`;
  return [`- ${order.id}${until}: ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
}

/**
 * The text of the orders that reach `role`: global ones, then local ones, each by `seq`; only
 * `instruction` orders. `undefined` when there is none. The prefix and the continuation package
 * (`renderContinuationOrders`) share it, so the same order reads the same in both.
 */
export function renderOrders(
  role: string,
  directives: readonly DirectiveRecord[],
  heading = '## Orders from the Producer',
): string | undefined {
  const reaching = directives
    .filter(
      (order) =>
        order.kind === 'instruction' && (order.roles.length === 0 || order.roles.includes(role)),
    )
    .sort((a, b) => a.seq - b.seq);
  const global = reaching.filter((order) => order.scope === 'global');
  const local = reaching.filter((order) => order.scope === 'local');
  if (global.length === 0 && local.length === 0) return undefined;
  const parts = [heading, ORDERS_INTRO];
  if (global.length > 0) parts.push(['### Global orders', ...global.map(orderItem)].join('\n'));
  if (local.length > 0) parts.push(['### Local orders', ...local.map(orderItem)].join('\n'));
  return parts.join('\n\n');
}

function toolsSection(role: string, tools: readonly ToolDefinition[]): string {
  const lines = toolsOfRole(tools, role).map(
    (tool) => `- \`${tool.name}\`${EFFECT_NOTE[tool.effect]}`,
  );
  return ['## Your tools', TOOLS_INTRO, lines.join('\n')].join('\n\n');
}

/**
 * Builds the stable prefix of a session (architecture 5.10): project rules, then the orders
 * in force, then the role, its tools and the contract, in this order, so that two sessions of the
 * same role and project share the longest possible beginning for the prompt cache. An order that
 * starts, ends, is revoked or suspended changes the prefix of the next sessions only; the
 * variable part of the prompt (the worktree path, the demand) goes after this text.
 *
 * [proposta] Layout: Markdown sections `## Project rules`, `## Orders from the Producer` (global
 * and local lists apart, the local one prevailing), `## Your role`, `## Your tools` (generated
 * from the registry, so it can never name a tool the role does not have) and `## Contract`.
 * Empty sections are left out. Pure: no clock, no I/O, same input and same text.
 */
export function assemblePrefix(input: PrefixInput): string {
  const sections: string[] = [];
  const rules = input.projectRules?.trim();
  if (rules !== undefined && rules !== '') sections.push(`## Project rules\n\n${rules}`);
  const orders = renderOrders(input.role, input.directives ?? []);
  if (orders !== undefined) sections.push(orders);
  sections.push(`## Your role: ${input.role}\n\n${input.rolePrompt.trim()}`);
  sections.push(toolsSection(input.role, input.tools));
  const contract = input.contract?.trim();
  if (contract !== undefined && contract !== '') sections.push(`## Contract\n\n${contract}`);
  return `${sections.join('\n\n')}\n`;
}
