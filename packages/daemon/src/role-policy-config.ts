// SPDX-License-Identifier: MPL-2.0
import { NO_RULE, PERMISSION_RULE_ACTIONS, ROLE_IDS } from '@otheater/core';
import { z } from 'zod';

/**
 * `roles.<role>.policy`: the tool policy of a role, as the configuration, a project and a scenario
 * write it (architecture 5.2 and 5.8, Phase 4 P1; N99). Every key is optional: what a key leaves
 * out is the default of the role (`defaultPolicySettings`), which is the policy the daemon used
 * before the policy had a configuration. [proposta] The key names; the architecture fixes only
 * `roles.<role>.policy`.
 *
 * The override opens only what is safe (N99): the daemon's shells (`native_shell: shells`), the
 * network domains and the native write tools. The bypass of a permission, the shell of the client
 * and a write outside the worktree stay forbidden: their keys exist so a file that tries to open
 * them is refused with a message that says so, and not ignored in silence.
 */

/** Native tools of a role (the neutral names of `RolePolicy.nativeTools`). */
export const POLICY_NATIVE_TOOLS = ['read', 'search', 'edit', 'write'] as const;

/** `none`: no shell. `shells`: the shells of the daemon (P3). The shell of the client is never a value. */
export const POLICY_NATIVE_SHELL_MODES = ['none', 'shells'] as const;

/**
 * `reject`: every request that reaches layer 2 is rejected. `rules`: the rules of
 * `roles.<role>.policy.rules` answer it, and what no rule matches is rejected (P2).
 */
export const POLICY_ON_ASK_MODES = ['reject', 'rules'] as const;

/** Modes of `on_ask` the daemon accepts today: P2 opened `rules`. */
export const POLICY_ON_ASK_AVAILABLE: readonly (typeof POLICY_ON_ASK_MODES)[number][] = [
  'reject',
  'rules',
];

/** How many rules one `policy.rules` list may have. [proposta] */
export const POLICY_RULES_MAX = 100;

/**
 * Names the client's own shell goes by, in the `tool` of a rule (lower case). A rule that releases
 * one of them is refused (N99): the shell of the client is never opened. [proposta] The list is of
 * the tools of Phase 0 (Claude Code `Bash`, Codex and OpenCode `shell`/`bash`); a client that names
 * its shell differently is still rejected at run time through the ACP kind `execute`.
 */
export const CLIENT_SHELL_TOOL_NAMES: readonly string[] = [
  'bash',
  'shell',
  'sh',
  'zsh',
  'execute',
  'exec',
  'terminal',
  'powershell',
  'cmd',
];

/** ACP kinds that no rule releases: the shell of the client and the change of mode (N99). */
export const FORBIDDEN_RULE_KINDS: readonly string[] = ['execute', 'switch_mode'];

const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A path pattern that leaves the worktree: absolute (`/`, `\`, `C:`), `~`, or with a `..` segment. */
function leavesWorktree(pattern: string): boolean {
  const flat = pattern.replaceAll('\\', '/');
  return (
    flat.startsWith('/') ||
    flat.startsWith('~') ||
    /^[A-Za-z]:/.test(flat) ||
    flat.split('/').includes('..')
  );
}

/**
 * One rule of `roles.<role>.policy.rules` (Phase 4, P2). [proposta] The format: `action` and at
 * least one of `kind`, `tool`, `path`; `id` is optional (the daemon names the rule `rules[<index>]`
 * then). Unknown keys are refused. A rule that releases (`allow`) what N99 forbids is refused here:
 * the client's shell (kind `execute`, a shell tool name), a change of mode (kind `switch_mode`) and
 * a write outside the worktree (a `path` that is absolute, starts with `~` or has `..`). The network
 * outside `network.allow` depends on the merged layers, so `resolveRolePolicy` checks it.
 */
export const PolicyRuleSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(RULE_ID_PATTERN, {
        message: 'rules[].id: letters, digits, ".", "_" and "-", starting with a letter or digit',
      })
      .refine((id) => id !== NO_RULE, {
        message: `rules[].id: "${NO_RULE}" is reserved for "no rule decided"`,
      })
      .optional(),
    action: z.enum(PERMISSION_RULE_ACTIONS, {
      error: (issue) =>
        `rules[].action: ${JSON.stringify(issue.input)} is not accepted; use "allow" or "reject"`,
    }),
    kind: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_*-]+$/, {
        message: 'rules[].kind: an ACP tool kind (read, edit, fetch...), "*" stands for any run',
      })
      .optional(),
    tool: z.string().min(1).max(128).optional(),
    path: z.string().min(1).max(512).optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.kind === undefined && rule.tool === undefined && rule.path === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a rule names at least one of "kind", "tool" and "path"',
      });
    }
    if (rule.action !== 'allow') return;
    if (rule.kind !== undefined && FORBIDDEN_RULE_KINDS.includes(rule.kind.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `rules[].kind: ${JSON.stringify(rule.kind)} cannot be allowed: ${
          rule.kind.toLowerCase() === 'execute'
            ? "the client's own shell is always rejected"
            : 'a change of mode is the way into a bypass and is always rejected'
        } (N99)`,
      });
    }
    if (rule.tool !== undefined && CLIENT_SHELL_TOOL_NAMES.includes(rule.tool.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['tool'],
        message: `rules[].tool: ${JSON.stringify(rule.tool)} is the client's own shell and cannot be allowed (N99)`,
      });
    }
    if (rule.path !== undefined && leavesWorktree(rule.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: `rules[].path: ${JSON.stringify(rule.path)} leaves the worktree; a path pattern is relative to it, with no "..", and a write outside it is always rejected (N99)`,
      });
    }
  });
export type PolicyRule = z.output<typeof PolicyRuleSchema>;

/** The list of rules: bounded, and an explicit id appears once. */
export const PolicyRulesSchema = z
  .array(PolicyRuleSchema)
  .max(POLICY_RULES_MAX, { message: `rules: at most ${POLICY_RULES_MAX} rules` })
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    rules.forEach((rule, index) => {
      if (rule.id === undefined) return;
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `rules[].id: ${JSON.stringify(rule.id)} appears twice`,
        });
      }
      seen.add(rule.id);
    });
  });

const forbidden = (key: string, why: string) => ({
  error: (issue: { input?: unknown }) =>
    `${key}: ${JSON.stringify(issue.input)} is refused: ${why} (N99)`,
});

const HOST_LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
/** `host.tld` or `*.host.tld`: at least two labels, so `*.com` and a lone `*` do not match. */
const DOMAIN_PATTERN = new RegExp(`^(\\*\\.)?${HOST_LABEL}(\\.${HOST_LABEL})+$`);

/**
 * A domain of `network.allow`: a host name, or `*.` and a host name for its subdomains. A bare `*`,
 * a scheme, a port, a path, a single label and a wildcard over a top-level domain (`*.com`) are
 * refused: the list must say which sites the role may reach, and layer 3 (P4) compares host names.
 * `localhost` is accepted as is. A wildcard over a public suffix such as `*.co.uk` passes: the
 * daemon has no suffix list [N].
 */
export const PolicyDomainSchema = z
  .string()
  .transform((text) => text.trim().toLowerCase())
  .refine((text) => text === 'localhost' || DOMAIN_PATTERN.test(text), {
    message:
      'network.allow takes host names (example.com) or subdomain patterns (*.example.com), without scheme, port or path; a lone "*" or a wildcard over a top-level domain is refused (N99)',
  });

/** One `roles.<role>.policy`, every key optional (see the module comment). */
export const RolePolicySettingsSchema = z.strictObject({
  native_tools: z.array(z.enum(POLICY_NATIVE_TOOLS)).optional(),
  native_shell: z
    .enum(POLICY_NATIVE_SHELL_MODES, {
      error: (issue) =>
        `native_shell: ${JSON.stringify(issue.input)} is refused: accepted values are "none" and "shells" (the daemon's shells); the shell of the client itself is always forbidden (N99)`,
    })
    .optional(),
  network: z.strictObject({ allow: z.array(PolicyDomainSchema) }).optional(),
  on_ask: z
    .enum(POLICY_ON_ASK_MODES)
    .refine((mode) => POLICY_ON_ASK_AVAILABLE.includes(mode), {
      message: `on_ask: accepted values are ${POLICY_ON_ASK_AVAILABLE.map((mode) => `"${mode}"`).join(' and ')}`,
    })
    .optional(),
  rules: PolicyRulesSchema.optional(),
  bypass: z
    .literal(
      'forbidden',
      forbidden('bypass', 'a permission is never bypassed; the only value is "forbidden"'),
    )
    .optional(),
  write_scope: z
    .literal(
      'worktree',
      forbidden(
        'write_scope',
        'a role writes only inside its worktree; the only value is "worktree"',
      ),
    )
    .optional(),
});
export type RolePolicySettings = z.output<typeof RolePolicySettingsSchema>;

/** `roles.<role>`: today only the policy; `requires` and `preset` join it in their steps. */
export const RoleConfigSchema = z.strictObject({
  policy: RolePolicySettingsSchema.optional(),
});

/**
 * The `roles` block: one optional entry per role of the registry. [proposta] An object with the
 * known roles, not a free map, so a typo in a role name is refused and the keys the architecture
 * reserves under `roles` (`preset`, `capability_check`) have room to come in.
 */
export const RolesConfigSchema = z.strictObject(
  Object.fromEntries(ROLE_IDS.map((role) => [role, RoleConfigSchema.optional()])) as Record<
    (typeof ROLE_IDS)[number],
    z.ZodOptional<typeof RoleConfigSchema>
  >,
);
