// SPDX-License-Identifier: MPL-2.0
import { ROLE_IDS } from '@otheater/core';
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
 * The browser tools of the framework server (`browser_*`, architecture 5.19) a role gets
 * [proposta]. `none`: no browser tool. `read`: the tools that only look (`browser_open`,
 * `browser_read`, `browser_screenshot`: the tools whose effect is not `external_write`). `full`:
 * also the ones that act on a page (`browser_click`, `browser_fill`, `browser_press_key`: effect
 * `external_write`). The rest of the rules (domains, local and file URLs, approval) is the `browser`
 * block of the configuration.
 */
export const POLICY_BROWSER_MODES = ['none', 'read', 'full'] as const;

/** `reject`: every request that reaches layer 2 is rejected. `rules` waits for P2. */
export const POLICY_ON_ASK_MODES = ['reject', 'rules'] as const;

/** Modes of `on_ask` the daemon accepts today. [proposta] P2 adds `rules` here. */
export const POLICY_ON_ASK_AVAILABLE: readonly (typeof POLICY_ON_ASK_MODES)[number][] = ['reject'];

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
  browser: z.enum(POLICY_BROWSER_MODES).optional(),
  on_ask: z
    .enum(POLICY_ON_ASK_MODES)
    .refine((mode) => POLICY_ON_ASK_AVAILABLE.includes(mode), {
      message:
        'on_ask: "rules" needs the release rules of layer 2 (Phase 4, P2), which do not exist yet; only "reject" is accepted until then',
    })
    .optional(),
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
