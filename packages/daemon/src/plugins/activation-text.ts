// SPDX-License-Identifier: MPL-2.0
import {
  PLUGIN_EVENT_PREFIX,
  type PluginManifest,
  type PluginToolManifest,
  type ToolEffectClass,
} from '@otheater/core';
import type { TFunction } from 'i18next';

/**
 * What the Producer sees before a plugin is turned on in a project (N236, architecture 5.14): the
 * server that will run, the tools with their roles and effects, the secrets it asks for and the
 * events it publishes. {@link summarizeActivation} is the data (the terminal interface of P11 draws
 * the same data, so the two say the same thing), {@link formatActivation} is the text of
 * `ot plugin enable`, from the catalogs of the daemon (`plugin.activation.*`).
 */

export interface ActivationToolSummary {
  readonly name: string;
  /** Empty when only the panel uses the tool. */
  readonly roles: readonly string[];
  readonly specialties: readonly string[];
  readonly effects: ToolEffectClass;
  /** Every call waits for the Producer. */
  readonly requiresProducerApproval: boolean;
}

export interface ActivationSummary {
  readonly id: string;
  readonly version: string;
  readonly description: string | undefined;
  /** What runs: a command (stdio) or the address of a server that is already running (http). */
  readonly server:
    | {
        readonly type: 'stdio';
        readonly command: readonly string[];
        readonly cwd: string | undefined;
      }
    | { readonly type: 'http'; readonly url: string };
  readonly tools: readonly ActivationToolSummary[];
  /** The names of the secrets, never their values. */
  readonly secrets: readonly string[];
  /** The full types, `plugin.<id>.<name>`. */
  readonly events: readonly string[];
  /** The number of blocks of the panel (drawn by the interface from data; no code of the plugin). */
  readonly panelBlocks: number;
}

export function summarizeActivation(manifest: PluginManifest): ActivationSummary {
  const server: ActivationSummary['server'] =
    manifest.server.type === 'stdio'
      ? {
          type: 'stdio',
          command: [...manifest.server.command, ...(manifest.server.args ?? [])],
          cwd: manifest.server.cwd,
        }
      : { type: 'http', url: manifest.server.url };
  return {
    id: manifest.id,
    version: manifest.version,
    description: manifest.description,
    server,
    tools: manifest.tools.map((tool: PluginToolManifest) => ({
      name: tool.name,
      roles: tool.roles,
      specialties: tool.specialties ?? [],
      effects: tool.effects,
      requiresProducerApproval: tool.requires_producer_approval,
    })),
    secrets: manifest.secrets,
    events: manifest.events.map((name) => `${PLUGIN_EVENT_PREFIX}${manifest.id}.${name}`),
    panelBlocks: manifest.panel.length,
  };
}

/** The text of the summary, one line per fact, in the language of `t`. */
export function formatActivation(summary: ActivationSummary, t: TFunction): string[] {
  const lines: string[] = [
    t('plugin.activation.title', { id: summary.id, version: summary.version }),
  ];
  if (summary.description !== undefined) lines.push(`  ${summary.description}`);
  lines.push(
    summary.server.type === 'stdio'
      ? t('plugin.activation.serverStdio', {
          command: summary.server.command.join(' '),
          cwd: summary.server.cwd ?? '.',
        })
      : t('plugin.activation.serverHttp', { url: summary.server.url }),
  );
  lines.push(t('plugin.activation.tools', { count: summary.tools.length }));
  for (const tool of summary.tools) {
    const roles = tool.roles.length === 0 ? t('plugin.activation.noRoles') : tool.roles.join(', ');
    lines.push(
      t('plugin.activation.tool', {
        name: tool.name,
        roles,
        effects: t(`plugin.activation.effect.${tool.effects}`),
        approval: tool.requiresProducerApproval ? t('plugin.activation.approval') : '',
      }),
    );
  }
  lines.push(
    summary.secrets.length === 0
      ? t('plugin.activation.secretsNone')
      : t('plugin.activation.secrets', { list: summary.secrets.join(', ') }),
  );
  lines.push(
    summary.events.length === 0
      ? t('plugin.activation.eventsNone')
      : t('plugin.activation.events', { list: summary.events.join(', ') }),
  );
  if (summary.panelBlocks > 0)
    lines.push(t('plugin.activation.panel', { count: summary.panelBlocks }));
  return lines;
}
