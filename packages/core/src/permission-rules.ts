// SPDX-License-Identifier: MPL-2.0
import type {
  PermissionAnswer,
  PermissionOption,
  PermissionRequest,
} from './ports/agent-session.js';

/**
 * Layer 2 of the permissions: the answer of the daemon to a `session/request_permission`
 * (architecture 5.8; Phase 4, P2). Pure and synchronous, with no module of Node, so the base of
 * the `ClientAdapter` can call it for every client.
 *
 * Order of the decision, from the strongest to the weakest [proposta]:
 * 0. a request that is an MCP tool call (`request.mcpTool`) is decided by the lists of the role
 *    alone (Codex asks about every MCP call, so a role would never reach its own tools otherwise);
 * 1. what is always rejected (N99): a write outside the worktree, the shell of the client, the
 *    network outside `network.allow` and a change of mode (the way into a bypass). No rule opens
 *    these, and the daemon configuration refuses a rule that tries;
 * 2. `editInWorktree: 'allow'` (N182, owner, 2026-11-20): an edit of files that are ALL inside the
 *    worktree, by a role whose `nativeTools` has `edit` or `write`, is allowed, whatever `onAsk`
 *    says and before the rules are read. It is a key of its own and not a rule of the list, so a
 *    user who writes `rules` does not lose it;
 * 3. with `onAsk: 'rules'`, the first rule of the policy that matches the request;
 * 4. no rule: the rejection of `onAsk: 'reject'`, which is also what a policy that does not use
 *    rules does for every request.
 */

/** What a rule answers. */
export const PERMISSION_RULE_ACTIONS = ['allow', 'reject'] as const;
export type PermissionRuleAction = (typeof PERMISSION_RULE_ACTIONS)[number];

/**
 * One release rule of `roles.<role>.policy.rules` (the daemon fills `id` when the configuration
 * leaves it out). A rule matches a request when EVERY criterion it names matches, and a rule names
 * at least one. `*` in `kind` and `tool` stands for any run of characters.
 * - `kind`: the ACP kind of the tool call (`read`, `edit`, `delete`, `move`, `search`, `fetch`, `other`...);
 * - `tool`: the name of the tool as the client announces it, when it does (an MCP tool, say);
 * - `path`: a glob, relative to the worktree (`src/**`, `docs/*.md`), for the file the request
 *   touches. `*` is a run inside one segment, `**` crosses segments, `?` is one character. Every
 *   path of the request must match, and a request with no path never matches a rule with `path`.
 */
export interface PermissionRule {
  readonly id: string;
  readonly action: PermissionRuleAction;
  readonly kind?: string;
  readonly tool?: string;
  readonly path?: string;
}

/** Why a request was answered the way it was; the stable values of the `reason` of the event. */
export const PERMISSION_REASONS = [
  'rule',
  'no_rule',
  'on_ask_reject',
  'write_outside_worktree',
  'write_target_unknown',
  'native_shell',
  'network_outside_allow',
  'mode_switch',
  'mcp_tool_of_role',
  'mcp_tool_outside_role',
  'edit_in_worktree',
  // The Producer's answer to the card of a plugin tool (Phase 9, P6): not a rule of layer 2, a
  // decision about one call. [proposta]
  'plugin_tool_approved',
  'plugin_tool_refused',
] as const;
export type PermissionReason = (typeof PERMISSION_REASONS)[number];

/**
 * The reasons for which a request is rejected whatever the rules say (N99). `mcp_tool_outside_role`
 * is deliberately NOT here: the list is the N99 set the daemon configuration refuses a rule for
 * (writes outside the worktree, the shell, the network, the mode), and a rule has no way to reach an
 * MCP call anyway, because an MCP request is decided by `mcpServers`/`mcpTools` before the rules
 * are read. The rejection is the fail-closed default of the role's list, not a prohibition that
 * must be kept out of the configuration.
 */
export const ALWAYS_REJECTED_REASONS = [
  'write_outside_worktree',
  'write_target_unknown',
  'native_shell',
  'network_outside_allow',
  'mode_switch',
] as const satisfies readonly PermissionReason[];

/** ACP kinds of tool calls that write to the file system. */
const WRITING_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move']);

/**
 * The part of the `RolePolicy` the answer reads. Structural, so this module does not import the
 * port that imports it.
 */
export interface PermissionPolicy {
  readonly onAsk: string;
  readonly rules?: readonly PermissionRule[];
  readonly network: { readonly allow: readonly string[] };
  /**
   * The MCP servers and tools of the role (`RolePolicy.mcpServers` and `mcpTools`), read for a
   * request that carries `mcpTool`. A server with no entry has no tool allowed. [proposta]
   */
  readonly mcpServers?: readonly string[];
  readonly mcpTools?: Readonly<Record<string, readonly string[] | 'all'>>;
  /**
   * `allow`: an edit inside the worktree is allowed before the rules (N182). Absent or `ask`: it
   * goes on to the rules and to `onAsk`. [proposta]
   */
  readonly editInWorktree?: 'allow' | 'ask';
  /** The native tools of the role (`RolePolicy.nativeTools`); `editInWorktree` needs `edit` or `write` here. */
  readonly nativeTools?: readonly string[];
}

/** What the answer needs besides the request and the policy. */
export interface PermissionContext {
  /** The worktree of the session. */
  readonly cwd: string;
  /**
   * Resolves the symbolic links of an absolute path (the deepest part that exists), so a link
   * inside the worktree that points out of it is seen for what it is. The daemon gives it
   * (`SessionPermissions.resolvePath`); without it the check is lexical only.
   */
  readonly resolvePath?: (absolute: string) => string;
}

/** The decision before it becomes an ACP answer. */
export interface PermissionDecision {
  readonly decision: PermissionRuleAction;
  /** Id of the rule that decided, or `none`. */
  readonly rule: string;
  readonly reason: PermissionReason;
  /** The rule that would have allowed it, had the request not been forbidden (N99). */
  readonly overruledRule?: string;
}

/** What the daemon is told about every request answered: the request, the decision and the answer. */
export interface PermissionOutcome extends PermissionDecision {
  readonly request: PermissionRequest;
  /** What went back to the client: `allow` or `reject` for a selected option, `cancelled` when none fits. */
  readonly answered: 'allow' | 'reject' | 'cancelled';
}

/** The id the events use when no rule decided. */
export const NO_RULE = 'none';

// ---- paths ----

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** `/a/b/../c` and `C:\a\b` as segments of a normalized absolute path; `undefined` for a relative one. */
function absoluteSegments(path: string): string[] | undefined {
  const flat = path.replaceAll('\\', '/');
  const rooted = flat.startsWith('/') || WINDOWS_DRIVE.test(flat);
  if (!rooted) return undefined;
  return walk(flat.split('/'));
}

function walk(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

/** Segments of an absolute path back to text: `/a/b`, or `C:/a/b` for a Windows drive. */
function render(segments: readonly string[]): string {
  return WINDOWS_DRIVE.test(segments[0] ?? '') ? segments.join('/') : `/${segments.join('/')}`;
}

/** The segments with the symbolic links resolved, when the context can. */
function resolved(segments: string[], resolve: PermissionContext['resolvePath']): string[] {
  if (resolve === undefined) return segments;
  return absoluteSegments(resolve(render(segments))) ?? segments;
}

/** The path of a request as segments of an absolute path: a relative one is taken from the worktree. */
function resolveSegments(
  path: string,
  cwd: readonly string[],
  context: PermissionContext,
): string[] {
  const own = absoluteSegments(path) ?? walk([...cwd, ...path.replaceAll('\\', '/').split('/')]);
  return resolved(own, context.resolvePath);
}

/** Path of the worktree as segments, with its links resolved. */
function cwdSegments(context: PermissionContext): string[] {
  const own = absoluteSegments(context.cwd) ?? walk(context.cwd.split('/'));
  return resolved(own, context.resolvePath);
}

interface Confined {
  /** Segments of the path below the worktree, or `undefined` when it is outside. */
  readonly inside: readonly string[] | undefined;
}

function confine(path: string, cwd: readonly string[], context: PermissionContext): Confined {
  const target = resolveSegments(path, cwd, context);
  const fold = WINDOWS_DRIVE.test(cwd[0] ?? '');
  const same = (a: string, b: string): boolean =>
    fold ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (target.length < cwd.length) return { inside: undefined };
  for (let i = 0; i < cwd.length; i += 1) {
    if (!same(target[i] ?? '', cwd[i] ?? '')) return { inside: undefined };
  }
  return { inside: target.slice(cwd.length) };
}

// ---- patterns ----

const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/g;

/** `*` as any run of characters (kinds and tool names). */
function wildcardMatches(pattern: string, value: string): boolean {
  const source = pattern.replace(REGEXP_SPECIAL, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${source}$`, 'u').test(value);
}

/** A path glob: `**` crosses segments, `*` and `?` stay inside one. */
export function globMatches(pattern: string, path: string): boolean {
  let source = '';
  const text = pattern.replaceAll('\\', '/');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (char === '*' && text[i + 1] === '*') {
      const slash = text[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(REGEXP_SPECIAL, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u').test(path);
}

/** The host of `url`, lower case, or `undefined` when it is not an absolute URL. */
function hostOf(url: string): string | undefined {
  try {
    const { hostname } = new URL(url);
    return hostname === '' ? undefined : hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * `host` against a domain of `network.allow`: `example.com` is that host alone, `*.example.com` is
 * its subdomains (not the host itself), as the list is validated in the configuration.
 */
export function domainAllows(allowed: string, host: string): boolean {
  const pattern = allowed.toLowerCase();
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

// ---- the decision ----

/** The reason a request is always rejected (N99), or `undefined` when the rules may decide. */
export function forbiddenReason(
  request: PermissionRequest,
  policy: PermissionPolicy,
  context: PermissionContext,
): PermissionReason | undefined {
  const kind = request.toolKind;
  if (kind === 'execute' || request.command !== undefined) return 'native_shell';
  if (kind === 'switch_mode') return 'mode_switch';
  if (kind === 'fetch' || request.url !== undefined) {
    const host = request.url === undefined ? undefined : hostOf(request.url);
    const allowed = host !== undefined && policy.network.allow.some((d) => domainAllows(d, host));
    if (!allowed) return 'network_outside_allow';
  }
  if (kind !== undefined && WRITING_KINDS.has(kind)) {
    const paths = request.locations ?? [];
    if (paths.length === 0) return 'write_target_unknown';
    const cwd = cwdSegments(context);
    for (const path of paths) {
      if (confine(path, cwd, context).inside === undefined) return 'write_outside_worktree';
    }
  }
  return undefined;
}

/** The first rule that matches the request, or `undefined`. */
export function matchRule(
  rules: readonly PermissionRule[],
  request: PermissionRequest,
  context: PermissionContext,
): PermissionRule | undefined {
  const cwd = cwdSegments(context);
  const relative = (request.locations ?? []).map((path) =>
    confine(path, cwd, context).inside?.join('/'),
  );
  return rules.find((rule) => {
    if (rule.kind !== undefined) {
      if (request.toolKind === undefined || !wildcardMatches(rule.kind, request.toolKind)) {
        return false;
      }
    }
    if (rule.tool !== undefined) {
      if (request.toolName === undefined || !wildcardMatches(rule.tool, request.toolName)) {
        return false;
      }
    }
    if (rule.path !== undefined) {
      const pattern = rule.path;
      if (relative.length === 0) return false;
      if (!relative.every((path) => path !== undefined && globMatches(pattern, path))) return false;
    }
    return true;
  });
}

/**
 * True when `editInWorktree: 'allow'` releases the request (N182): an edit (ACP kind `edit` alone;
 * `delete` and `move` are not edits of a file's content) of a role that has `edit` or `write` among
 * its native tools. That every path is inside the worktree is checked by {@link forbiddenReason},
 * which runs before this: a request with no path or with one outside is already a rejection.
 */
function editInWorktreeAllows(request: PermissionRequest, policy: PermissionPolicy): boolean {
  if (policy.editInWorktree !== 'allow' || request.toolKind !== 'edit') return false;
  const tools = policy.nativeTools ?? [];
  return tools.includes('edit') || tools.includes('write');
}

/** True when the role lists the MCP tool: its server in `mcpServers` and the tool (or `all`) for that server. */
function roleAllowsMcpTool(
  tool: NonNullable<PermissionRequest['mcpTool']>,
  policy: PermissionPolicy,
): boolean {
  if (!(policy.mcpServers ?? []).includes(tool.server)) return false;
  const tools = policy.mcpTools;
  if (tools === undefined || !Object.hasOwn(tools, tool.server)) return false;
  const listed = tools[tool.server];
  return listed === 'all' || (Array.isArray(listed) && listed.includes(tool.tool));
}

/**
 * What layer 2 decides for `request` under `policy`. A request that is an MCP tool call
 * (`request.mcpTool`) is decided first and by the lists of the role alone, whatever `onAsk` says:
 * `allow` for a tool the role lists, `reject` for any other. The client asks about every MCP call
 * (Codex does, [V] 2026-11-17), so without this the role could not use its own tools; and a request
 * with `mcpTool` is never the native shell, whatever its kind says. For every other request,
 * `onAsk: 'reject'` (and any value this function does not know) rejects everything; `rules`
 * rejects what is always rejected, then follows the first rule that matches.
 * `editInWorktree: 'allow'` (N182) sits between the two: after what is always rejected, before the
 * rules and `onAsk`, an edit inside the worktree is allowed with the reason `edit_in_worktree` and
 * no rule id. With an `onAsk` this function does not know it never allows.
 */
export function decidePermission(
  request: PermissionRequest,
  policy: PermissionPolicy,
  context: PermissionContext,
): PermissionDecision {
  if (request.mcpTool !== undefined) {
    const allowed = roleAllowsMcpTool(request.mcpTool, policy);
    return {
      decision: allowed ? 'allow' : 'reject',
      rule: NO_RULE,
      reason: allowed ? 'mcp_tool_of_role' : 'mcp_tool_outside_role',
    };
  }
  const knownOnAsk = policy.onAsk === 'reject' || policy.onAsk === 'rules';
  const forbidden = forbiddenReason(request, policy, context);
  if (knownOnAsk && forbidden === undefined && editInWorktreeAllows(request, policy)) {
    return { decision: 'allow', rule: NO_RULE, reason: 'edit_in_worktree' };
  }
  if (policy.onAsk !== 'rules') {
    return { decision: 'reject', rule: NO_RULE, reason: 'on_ask_reject' };
  }
  const rules = policy.rules ?? [];
  const matched = matchRule(rules, request, context);
  if (forbidden !== undefined) {
    return {
      decision: 'reject',
      rule: NO_RULE,
      reason: forbidden,
      ...(matched?.action === 'allow' ? { overruledRule: matched.id } : {}),
    };
  }
  if (matched === undefined) return { decision: 'reject', rule: NO_RULE, reason: 'no_rule' };
  return { decision: matched.action, rule: matched.id, reason: 'rule' };
}

function optionOf(
  request: PermissionRequest,
  kinds: readonly PermissionOption['kind'][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) return option;
  }
  return undefined;
}

/**
 * The ACP answer for a decision. A release picks `allow_once` and never `allow_always`: the client
 * may write the latter to the profile, where it would outlive the policy that granted it. A
 * rejection picks `reject_once`, then `reject_always`; with no option that refuses the answer is
 * `cancelled`, and so is a release the client offers no `allow_once` for (fail closed).
 */
export function answerOf(
  request: PermissionRequest,
  decision: PermissionDecision,
): PermissionAnswer {
  const kinds =
    decision.decision === 'allow'
      ? (['allow_once'] as const)
      : (['reject_once', 'reject_always'] as const);
  const option = optionOf(request, kinds);
  return option === undefined
    ? { outcome: 'cancelled' }
    : { outcome: 'selected', optionId: option.optionId };
}

/** What the answer says in the words of the event: the option that was selected tells allow from reject. */
export function answeredAs(
  request: PermissionRequest,
  answer: PermissionAnswer,
): PermissionOutcome['answered'] {
  if (answer.outcome === 'cancelled') return 'cancelled';
  const option = request.options.find((candidate) => candidate.optionId === answer.optionId);
  return option?.kind.startsWith('allow') === true ? 'allow' : 'reject';
}
