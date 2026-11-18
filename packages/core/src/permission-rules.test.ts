// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_REJECTED_REASONS,
  answerOf,
  answeredAs,
  decidePermission,
  domainAllows,
  forbiddenReason,
  globMatches,
  matchRule,
  NO_RULE,
  type PermissionOutcome,
  type PermissionPolicy,
  type PermissionRule,
} from './permission-rules.js';
import type { PermissionRequest } from './ports/agent-session.js';
import type { RolePolicy } from './ports/client-adapter.js';
import type { Profile } from './ports/executor.js';
import { FakeClientAdapter, FakeProcessLauncher, FakeSessionTransport } from './testing/index.js';

const CWD = '/work/tree';
const OPTIONS: PermissionRequest['options'] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: 'Always', kind: 'allow_always' },
  { optionId: 'no', name: 'No', kind: 'reject_once' },
];

function request(patch: Partial<PermissionRequest> = {}): PermissionRequest {
  return { toolCallId: 't1', toolKind: 'edit', options: OPTIONS, ...patch };
}

function policy(rules: readonly PermissionRule[], allow: readonly string[] = []): PermissionPolicy {
  return { onAsk: 'rules', rules, network: { allow } };
}

const decide = (req: PermissionRequest, p: PermissionPolicy, resolvePath?: (a: string) => string) =>
  decidePermission(req, p, { cwd: CWD, ...(resolvePath === undefined ? {} : { resolvePath }) });

const ALLOW_EDIT: PermissionRule = { id: 'edit', action: 'allow', kind: 'edit' };

describe('globMatches', () => {
  it.each([
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/deep/a.ts', false],
    ['src/**', 'src/a/b/c.ts', true],
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/a/b/c.ts', true],
    ['**/*.md', 'README.md', true],
    ['docs/?.md', 'docs/a.md', true],
    ['docs/?.md', 'docs/ab.md', false],
    ['a.b', 'axb', false],
    ['(x)+[y]', '(x)+[y]', true],
    ['src\\*.ts', 'src/a.ts', true],
  ])('%s against %s is %s', (pattern, path, expected) => {
    expect(globMatches(pattern, path)).toBe(expected);
  });
});

describe('domainAllows', () => {
  it('a plain domain is that host alone, a wildcard is the subdomains only', () => {
    expect(domainAllows('example.com', 'example.com')).toBe(true);
    expect(domainAllows('example.com', 'a.example.com')).toBe(false);
    expect(domainAllows('*.example.com', 'a.example.com')).toBe(true);
    expect(domainAllows('*.example.com', 'a.b.example.com')).toBe(true);
    expect(domainAllows('*.example.com', 'example.com')).toBe(false);
    expect(domainAllows('*.example.com', 'badexample.com')).toBe(false);
    expect(domainAllows('Example.COM', 'example.com')).toBe(true);
  });
});

describe('decidePermission, what a rule decides', () => {
  it('follows the first rule that matches (first wins)', () => {
    const rules: PermissionRule[] = [
      { id: 'no-secrets', action: 'reject', kind: 'edit', path: 'secrets/**' },
      { id: 'docs', action: 'allow', kind: 'edit', path: 'docs/**' },
      { id: 'all-edits', action: 'reject', kind: 'edit' },
    ];
    const at = (path: string) => decide(request({ locations: [path] }), policy(rules));
    expect(at('docs/a.md')).toEqual({ decision: 'allow', rule: 'docs', reason: 'rule' });
    expect(at('secrets/k')).toEqual({ decision: 'reject', rule: 'no-secrets', reason: 'rule' });
    expect(at('src/a.ts')).toEqual({ decision: 'reject', rule: 'all-edits', reason: 'rule' });
  });

  it('ANDs the criteria of one rule, and a rule with a criterion the request lacks does not match', () => {
    const rule: PermissionRule = {
      id: 'r',
      action: 'allow',
      kind: 'edit',
      tool: 'Write',
      path: 'a/**',
    };
    const ask = (patch: Partial<PermissionRequest>) => decide(request(patch), policy([rule]));
    expect(ask({ toolName: 'Write', locations: ['a/x'] }).decision).toBe('allow');
    expect(ask({ toolName: 'Edit', locations: ['a/x'] }).reason).toBe('no_rule');
    expect(ask({ locations: ['a/x'] }).reason).toBe('no_rule');
    expect(ask({ toolName: 'Write', locations: ['b/x'] }).reason).toBe('no_rule');
    expect(ask({ toolName: 'Write', toolKind: 'delete', locations: ['a/x'] }).reason).toBe(
      'no_rule',
    );
  });

  it('needs every path of the request to match the rule', () => {
    const rule: PermissionRule = { id: 'r', action: 'allow', path: 'a/**' };
    expect(decide(request({ locations: ['a/1', 'a/2'] }), policy([rule])).decision).toBe('allow');
    expect(decide(request({ locations: ['a/1', 'b/2'] }), policy([rule])).reason).toBe('no_rule');
  });

  it('a rule with a path never matches a request with none', () => {
    const rule: PermissionRule = { id: 'r', action: 'allow', path: '**' };
    expect(decide(request({ toolKind: 'read' }), policy([rule])).reason).toBe('no_rule');
  });

  it('matches kind and tool with * as any run (and case-sensitively)', () => {
    const rules: PermissionRule[] = [
      { id: 'mcp', action: 'allow', tool: 'mcp__otheater__*' },
      { id: 'r', action: 'allow', kind: 'rea*' },
    ];
    const p = policy(rules);
    expect(decide(request({ toolKind: 'other', toolName: 'mcp__otheater__submit' }), p).rule).toBe(
      'mcp',
    );
    expect(decide(request({ toolKind: 'read' }), p).rule).toBe('r');
    expect(decide(request({ toolKind: 'read', toolName: 'x' }), p).rule).toBe('r');
    expect(decide(request({ toolKind: 'other', toolName: 'MCP__otheater__x' }), p).reason).toBe(
      'no_rule',
    );
  });

  it('a request with no rule is rejected with the rule "none"', () => {
    const outcome = decide(request({ toolKind: 'read' }), policy([]));
    expect(outcome).toEqual({ decision: 'reject', rule: NO_RULE, reason: 'no_rule' });
  });

  it('on_ask: reject rejects everything, rules or not', () => {
    const p: PermissionPolicy = { onAsk: 'reject', rules: [ALLOW_EDIT], network: { allow: [] } };
    expect(decide(request({ locations: ['a'] }), p)).toEqual({
      decision: 'reject',
      rule: NO_RULE,
      reason: 'on_ask_reject',
    });
  });

  it('a policy with an onAsk it does not know also rejects', () => {
    const p = { onAsk: 'allow', rules: [ALLOW_EDIT], network: { allow: [] } };
    expect(decide(request({ locations: ['a'] }), p).decision).toBe('reject');
  });
});

describe('decidePermission, what is always rejected (N99)', () => {
  const ALLOW_ALL: PermissionRule = { id: 'all', action: 'allow', kind: '*' };
  const ALLOW_PATHS: PermissionRule = { id: 'paths', action: 'allow', path: '**' };

  it.each([
    ['a write above the worktree', { locations: ['../x'] }],
    ['a write to an absolute path elsewhere', { locations: ['/etc/passwd'] }],
    ['a write that climbs out in the middle', { locations: ['a/../../x'] }],
    ['an absolute path that only shares a prefix', { locations: ['/work/tree-other/x'] }],
    ['the worktree rewritten with ..', { locations: ['/work/tree/../other/x'] }],
    ['a Windows path', { locations: ['C:\\Users\\me\\x'] }],
    ['one path inside and one outside', { locations: ['a/ok', '/tmp/no'] }],
  ])('rejects %s even with a rule that allows it', (_name, patch) => {
    const outcome = decide(request(patch), policy([ALLOW_ALL, ALLOW_PATHS]));
    expect(outcome).toMatchObject({
      decision: 'reject',
      rule: NO_RULE,
      reason: 'write_outside_worktree',
    });
    expect(outcome.overruledRule).toBe('all');
  });

  it('rejects a write that says no file (it cannot be shown to be inside)', () => {
    expect(decide(request({}), policy([ALLOW_ALL])).reason).toBe('write_target_unknown');
    expect(decide(request({ locations: [] }), policy([ALLOW_ALL])).reason).toBe(
      'write_target_unknown',
    );
  });

  it.each(['edit', 'delete', 'move'])('treats a %s as a write', (toolKind) => {
    expect(decide(request({ toolKind, locations: ['/etc/x'] }), policy([ALLOW_ALL])).reason).toBe(
      'write_outside_worktree',
    );
  });

  it('lets a write inside the worktree through, however it is spelled', () => {
    for (const path of [
      'a.txt',
      './a.txt',
      'a/../b.txt',
      '/work/tree/a.txt',
      '/work//tree/./a.txt',
    ]) {
      expect(decide(request({ locations: [path] }), policy([ALLOW_EDIT])).decision).toBe('allow');
    }
  });

  it("rejects the client's shell, by kind and by the presence of a command", () => {
    const rules = [ALLOW_ALL, { id: 'cmd', action: 'allow', tool: 'Bash' } as PermissionRule];
    expect(decide(request({ toolKind: 'execute' }), policy(rules)).reason).toBe('native_shell');
    expect(
      decide(request({ toolKind: 'other', command: 'ls', toolName: 'Bash' }), policy(rules)).reason,
    ).toBe('native_shell');
    expect(decide(request({ toolKind: 'execute' }), policy(rules)).overruledRule).toBe('all');
  });

  it('rejects a change of mode, the way into a bypass', () => {
    expect(decide(request({ toolKind: 'switch_mode' }), policy([ALLOW_ALL])).reason).toBe(
      'mode_switch',
    );
  });

  it('rejects the network outside network.allow, and releases it inside', () => {
    const fetch = (url: string) => request({ toolKind: 'fetch', url });
    const p = policy([ALLOW_ALL], ['example.com', '*.docs.example.org']);
    expect(decide(fetch('https://example.com/x'), p)).toMatchObject({ decision: 'allow' });
    expect(decide(fetch('https://a.docs.example.org/x'), p)).toMatchObject({ decision: 'allow' });
    for (const url of [
      'https://evil.com/x',
      'https://example.com.evil.com/x',
      'https://docs.example.org/x',
      'not a url',
    ]) {
      expect(decide(fetch(url), p)).toMatchObject({
        decision: 'reject',
        reason: 'network_outside_allow',
      });
    }
    // No address at all: the host is unknown, so it is outside.
    expect(decide(request({ toolKind: 'fetch' }), p).reason).toBe('network_outside_allow');
    // A request that carries an address under another kind is the network all the same.
    expect(decide(request({ toolKind: 'other', url: 'https://evil.com' }), p).reason).toBe(
      'network_outside_allow',
    );
    expect(decide(fetch('https://example.com/x'), policy([ALLOW_ALL], [])).reason).toBe(
      'network_outside_allow',
    );
  });

  it('does not tell what an always-rejected request overruled when the rule was a rejection', () => {
    const outcome = decide(
      request({ locations: ['../x'] }),
      policy([{ id: 'n', action: 'reject', kind: 'edit' }]),
    );
    expect(outcome.reason).toBe('write_outside_worktree');
    expect(outcome.overruledRule).toBeUndefined();
  });

  it('lists the always-rejected reasons the events and the schema use', () => {
    expect(ALWAYS_REJECTED_REASONS).toEqual([
      'write_outside_worktree',
      'write_target_unknown',
      'native_shell',
      'network_outside_allow',
      'mode_switch',
    ]);
  });
});

describe('decidePermission, an MCP tool of the role (Codex asks about every MCP call)', () => {
  /** What codex-acp sends once the transport merged the tool call in: kind execute and the names. */
  const mcp = (server: string, tool: string, patch: Partial<PermissionRequest> = {}) =>
    request({ toolKind: 'execute', mcpTool: { server, tool }, ...patch });
  const roleOf = (patch: Partial<PermissionPolicy> = {}): PermissionPolicy => ({
    onAsk: 'reject',
    network: { allow: [] },
    mcpServers: ['otheater'],
    mcpTools: { otheater: ['submit_plan'] },
    ...patch,
  });

  it('allows a tool the role lists, with allow_once, even with onAsk reject', () => {
    const decision = decide(mcp('otheater', 'submit_plan'), roleOf());
    expect(decision).toEqual({ decision: 'allow', rule: NO_RULE, reason: 'mcp_tool_of_role' });
    expect(answerOf(mcp('otheater', 'submit_plan'), decision)).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    });
  });

  it('allows it with onAsk rules as well, and never as native_shell', () => {
    const decision = decide(mcp('otheater', 'submit_plan'), { ...roleOf(), onAsk: 'rules' });
    expect(decision).toMatchObject({ decision: 'allow', reason: 'mcp_tool_of_role' });
  });

  it('allows every tool of the server when the role says all', () => {
    const p = roleOf({ mcpTools: { otheater: 'all' } });
    expect(decide(mcp('otheater', 'anything'), p)).toMatchObject({ reason: 'mcp_tool_of_role' });
  });

  it('rejects a server the role does not list', () => {
    const decision = decide(mcp('other', 'submit_plan'), roleOf());
    expect(decision).toEqual({
      decision: 'reject',
      rule: NO_RULE,
      reason: 'mcp_tool_outside_role',
    });
    expect(answerOf(mcp('other', 'submit_plan'), decision)).toEqual({
      outcome: 'selected',
      optionId: 'no',
    });
  });

  it('rejects a tool the list of the server does not have', () => {
    expect(decide(mcp('otheater', 'drop_db'), roleOf())).toMatchObject({
      decision: 'reject',
      reason: 'mcp_tool_outside_role',
    });
  });

  it('rejects a listed server with no entry in mcpTools, and a policy without the fields', () => {
    expect(decide(mcp('otheater', 'submit_plan'), roleOf({ mcpTools: {} }))).toMatchObject({
      reason: 'mcp_tool_outside_role',
    });
    expect(
      decide(mcp('otheater', 'submit_plan'), { onAsk: 'rules', network: { allow: [] } }),
    ).toMatchObject({ reason: 'mcp_tool_outside_role' });
  });

  it('does not read names that are properties of Object', () => {
    const p = roleOf({ mcpServers: ['toString'], mcpTools: {} });
    expect(decide(mcp('toString', 'x'), p)).toMatchObject({ reason: 'mcp_tool_outside_role' });
  });

  it('no rule opens an MCP tool outside the role', () => {
    const p: PermissionPolicy = {
      ...roleOf(),
      onAsk: 'rules',
      rules: [{ id: 'all', action: 'allow', kind: '*' }],
    };
    expect(decide(mcp('other', 'x'), p)).toMatchObject({ reason: 'mcp_tool_outside_role' });
  });

  it('keeps an execute with no mcpTool where it was: native_shell, or on_ask_reject', () => {
    const shell = request({ toolKind: 'execute', command: 'ls' });
    const rules = { ...roleOf(), onAsk: 'rules' };
    expect(decide(shell, rules)).toMatchObject({ reason: 'native_shell' });
    expect(decide(shell, roleOf())).toMatchObject({ reason: 'on_ask_reject' });
  });
});

describe('the symbolic links of the worktree', () => {
  /** `/work/tree/link` points at `/elsewhere`; nothing else is a link. */
  const resolvePath = (absolute: string): string =>
    absolute.startsWith('/work/tree/link')
      ? absolute.replace('/work/tree/link', '/elsewhere')
      : absolute;

  it('rejects a write through a link that leaves the worktree', () => {
    const outcome = decide(
      request({ locations: ['link/x.txt'] }),
      policy([ALLOW_EDIT]),
      resolvePath,
    );
    expect(outcome).toMatchObject({
      decision: 'reject',
      reason: 'write_outside_worktree',
      overruledRule: 'edit',
    });
  });

  it('without the resolver the check is lexical only, and a link goes unseen', () => {
    expect(decide(request({ locations: ['link/x.txt'] }), policy([ALLOW_EDIT])).decision).toBe(
      'allow',
    );
  });

  it('a worktree that is itself behind a link still holds its own files', () => {
    const through = (absolute: string): string => absolute.replace('/work/tree', '/real/tree');
    const outcome = decidePermission(request({ locations: ['a.txt'] }), policy([ALLOW_EDIT]), {
      cwd: CWD,
      resolvePath: through,
    });
    expect(outcome.decision).toBe('allow');
  });
});

describe('forbiddenReason and matchRule alone', () => {
  it('forbiddenReason is undefined for a read', () => {
    expect(
      forbiddenReason(request({ toolKind: 'read' }), policy([]), { cwd: CWD }),
    ).toBeUndefined();
  });

  it('matchRule matches a path relative to the worktree, whether the request writes it absolute or relative', () => {
    const rules: PermissionRule[] = [{ id: 'd', action: 'allow', path: 'docs/*.md' }];
    for (const path of ['docs/a.md', '/work/tree/docs/a.md']) {
      expect(matchRule(rules, request({ locations: [path] }), { cwd: CWD })?.id).toBe('d');
    }
    expect(
      matchRule(rules, request({ locations: ['/other/docs/a.md'] }), { cwd: CWD }),
    ).toBeUndefined();
  });
});

describe('the answer to the client', () => {
  const allowDecision = { decision: 'allow', rule: 'r', reason: 'rule' } as const;
  const rejectDecision = { decision: 'reject', rule: NO_RULE, reason: 'no_rule' } as const;

  it('a release selects allow_once and never allow_always', () => {
    expect(answerOf(request(), allowDecision)).toEqual({ outcome: 'selected', optionId: 'yes' });
    const onlyAlways = request({
      options: [{ optionId: 'always', name: 'A', kind: 'allow_always' }],
    });
    expect(answerOf(onlyAlways, allowDecision)).toEqual({ outcome: 'cancelled' });
  });

  it('a rejection prefers reject_once, then reject_always, else cancels', () => {
    const both = request({
      options: [
        { optionId: 'ra', name: 'RA', kind: 'reject_always' },
        { optionId: 'ro', name: 'RO', kind: 'reject_once' },
      ],
    });
    expect(answerOf(both, rejectDecision)).toEqual({ outcome: 'selected', optionId: 'ro' });
    const onlyAlways = request({
      options: [{ optionId: 'ra', name: 'RA', kind: 'reject_always' }],
    });
    expect(answerOf(onlyAlways, rejectDecision)).toEqual({ outcome: 'selected', optionId: 'ra' });
    expect(answerOf(request({ options: [] }), rejectDecision)).toEqual({ outcome: 'cancelled' });
    expect(answerOf(request({ options: OPTIONS.slice(0, 2) }), rejectDecision)).toEqual({
      outcome: 'cancelled',
    });
  });

  it('answeredAs tells what went back', () => {
    expect(answeredAs(request(), { outcome: 'selected', optionId: 'yes' })).toBe('allow');
    expect(answeredAs(request(), { outcome: 'selected', optionId: 'no' })).toBe('reject');
    expect(answeredAs(request(), { outcome: 'cancelled' })).toBe('cancelled');
    expect(answeredAs(request(), { outcome: 'selected', optionId: 'unknown' })).toBe('reject');
  });
});

describe('ClientAdapter.answerPermission with rules, through the session', () => {
  const profile: Profile = { client: 'fake', profile: 'p', id: 'fake/p', dir: '/profiles/fake/p' };
  const base: RolePolicy = {
    nativeTools: ['read'],
    nativeShell: 'none',
    mcpServers: [],
    mcpTools: {},
    onAsk: 'rules',
    bypass: 'forbidden',
    writeScope: 'worktree',
    network: { allow: [] },
    rules: [ALLOW_EDIT],
  };

  async function session(
    rolePolicy: RolePolicy,
    permissions?: Parameters<FakeClientAdapter['openSession']>[4],
  ) {
    const adapter = new FakeClientAdapter({
      launcher: new FakeProcessLauncher(),
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
    });
    const via = new FakeSessionTransport();
    await adapter.openSession(profile, rolePolicy, CWD, via, permissions);
    const opened = via.opened[0];
    if (opened === undefined) throw new Error('not opened');
    return opened;
  }

  it('answers by the rules and tells the outcome to onDecision, with the cwd of the session', async () => {
    const seen: PermissionOutcome[] = [];
    const opened = await session(base, { permissions: { onDecision: (o) => seen.push(o) } });
    expect(opened.onPermission(request({ locations: ['a.txt'] }))).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    });
    expect(opened.onPermission(request({ locations: ['/etc/x'] }))).toEqual({
      outcome: 'selected',
      optionId: 'no',
    });
    expect(seen.map((o) => [o.decision, o.rule, o.reason, o.answered])).toEqual([
      ['allow', 'edit', 'rule', 'allow'],
      ['reject', 'none', 'write_outside_worktree', 'reject'],
    ]);
    expect(seen[0]?.request.locations).toEqual(['a.txt']);
  });

  it('hands resolvePath to the decision', async () => {
    const opened = await session(base, {
      permissions: { resolvePath: (path) => path.replace('/work/tree/a', '/elsewhere') },
    });
    expect(opened.onPermission(request({ locations: ['a/x.txt'] }))).toEqual({
      outcome: 'selected',
      optionId: 'no',
    });
  });

  it('survives an onDecision that throws, and the answer still goes back', async () => {
    const opened = await session(base, {
      permissions: {
        onDecision: () => {
          throw new Error('listener broke');
        },
      },
    });
    expect(opened.onPermission(request({ locations: ['a.txt'] }))).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    });
  });

  it('with on_ask: reject, rules in the policy are not read', async () => {
    const seen: PermissionOutcome[] = [];
    const opened = await session(
      { ...base, onAsk: 'reject' },
      { permissions: { onDecision: (o) => seen.push(o) } },
    );
    expect(opened.onPermission(request({ locations: ['a.txt'] }))).toEqual({
      outcome: 'selected',
      optionId: 'no',
    });
    expect(seen[0]).toMatchObject({ reason: 'on_ask_reject', rule: 'none', answered: 'reject' });
  });

  it('works with no permissions option at all (nobody listens)', async () => {
    const opened = await session(base);
    expect(opened.onPermission(request({ locations: ['a.txt'] }))).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    });
  });
});
