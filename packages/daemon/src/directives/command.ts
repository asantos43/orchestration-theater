// SPDX-License-Identifier: MPL-2.0
import { hasErrorCode, type DirectiveRecord, type DirectiveState } from '@otheater/core';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandContext } from '../commands.js';
import { compose } from '../compose.js';
import { loadConfig } from '../config.js';
import { InstanceLock, releaseOnFailure } from '../instance-lock.js';
import { dataPaths, ensureDataDir } from '../paths.js';
import { buildDaemonRegistries } from '../registries.js';
import { DirectiveService, summarizeDirective, type DirectiveInput } from './service.js';
import type { ValidityText } from './spec.js';

/** What `ot directives` takes from the command line (parsed by `cli.ts`). */
export interface DirectivesOptions {
  /** The scenario of a local order; without it an `add` makes a global one. */
  readonly scenario?: string | undefined;
  readonly kind?: string | undefined;
  readonly role: readonly string[];
  readonly ruleKey?: string | undefined;
  readonly ruleValue?: string | undefined;
  readonly suspends?: string | undefined;
  readonly replaces?: string | undefined;
  readonly from?: string | undefined;
  readonly until?: string | undefined;
  readonly for?: string | undefined;
  /** `extend`: take the end away, the order has no end. */
  readonly forever: boolean;
  readonly reason?: string | undefined;
  /** `list`: also the orders that expired or were revoked. */
  readonly all: boolean;
}

export const DIRECTIVE_ACTIONS = ['list', 'show', 'add', 'extend', 'suspend', 'revoke'] as const;
export type DirectiveAction = (typeof DIRECTIVE_ACTIONS)[number];

export function isDirectiveAction(name: string): name is DirectiveAction {
  return (DIRECTIVE_ACTIONS as readonly string[]).includes(name);
}

const KINDS = ['instruction', 'rule', 'suspension'] as const;
type Kind = (typeof KINDS)[number];

/** A rule value is JSON when it parses (`true`, `3`, `["a"]`) and plain text otherwise. [proposta] */
function ruleValueOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function validityOf(options: DirectivesOptions): ValidityText {
  return {
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.until === undefined ? {} : { until: options.until }),
    ...(options.for === undefined ? {} : { for: options.for }),
  };
}

function windowOf(d: DirectiveRecord): string {
  const summary = summarizeDirective(d);
  const until = summary.until as string | null;
  return until === null ? '' : ` until ${until} ${d.timezone}`;
}

function lineOf(d: DirectiveRecord): string {
  const where = d.scope === 'global' ? 'global' : `scenario ${d.scenarioId ?? '?'}`;
  return `${d.id} [${d.state}] ${where} ${d.kind}${windowOf(d)}: ${d.text}`;
}

/**
 * `ot directives <list|show|add|extend|suspend|revoke>`. [proposta] The terminal writes straight to
 * the store, with the origin `terminal` (the Producer's own hand: no draft, nothing to confirm),
 * so it needs the data directory to itself: with a daemon running it refuses, as `ot restore` does.
 * Through the daemon, the Director proposes and the Producer confirms.
 */
export async function runDirectivesCommand(
  context: CommandContext,
  action: DirectiveAction,
  args: readonly string[],
  options: DirectivesOptions,
): Promise<number> {
  const { t } = context;
  const usage = (key: string): number => {
    context.err(t(key));
    context.err(t('usage.hint'));
    return EXIT_USAGE;
  };

  // The arguments are checked before the store is touched.
  const [first, ...rest] = args;
  if (options.kind !== undefined && !(KINDS as readonly string[]).includes(options.kind)) {
    return usage('usage.directiveKind');
  }
  switch (action) {
    case 'list':
      if (args.length > 0) return usage('usage.directiveTooMany');
      break;
    case 'show':
    case 'revoke':
    case 'extend':
      if (first === undefined) return usage('usage.directiveNeedsId');
      if (rest.length > 0) return usage('usage.directiveTooMany');
      if (action === 'revoke' && (options.reason ?? '').trim() === '') {
        return usage('usage.directiveNeedsReason');
      }
      break;
    case 'add':
      if (first === undefined) return usage('usage.directiveNeedsText');
      if (rest.length > 0) return usage('usage.directiveTooMany');
      break;
    case 'suspend':
      if (first === undefined) return usage('usage.directiveNeedsId');
      if (rest.length > 1) return usage('usage.directiveTooMany');
      if (options.scenario === undefined) return usage('usage.directiveNeedsScenario');
      break;
  }

  const paths = dataPaths(context.dataDir);
  await ensureDataDir(paths.dataDir);
  const config = await loadConfig(paths.config);
  let lock: InstanceLock;
  try {
    lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
  } catch (error) {
    if (hasErrorCode(error, 'CONFLICT')) {
      context.err(t('directives.daemonRunning'));
      return EXIT_FAILED;
    }
    throw error;
  }
  const registries = buildDaemonRegistries();
  const composition = await releaseOnFailure(lock, () =>
    compose(config, {
      dataDir: paths.dataDir,
      events: { registry: registries.events, unknownType: config.events.unknown_type },
      ...(context.overrides === undefined ? {} : { overrides: context.overrides }),
    }),
  );
  try {
    const service = new DirectiveService({
      store: composition.store,
      clock: composition.clock,
      ruleKeys: registries.ruleKeys,
      settings: {
        timezone: config.directives.timezone,
        expiringNoticeMs: config.directives.expiring_notice,
      },
      logger: composition.logger,
    });
    return await perform(context, service, action, first, rest, options);
  } finally {
    await composition.close().catch(() => undefined);
    await lock.release();
  }
}

async function perform(
  context: CommandContext,
  service: DirectiveService,
  action: DirectiveAction,
  first: string | undefined,
  rest: readonly string[],
  options: DirectivesOptions,
): Promise<number> {
  const { t, out, err } = context;
  const missing = (id: string): number => {
    err(t('directives.notFound', { id }));
    return EXIT_FAILED;
  };

  switch (action) {
    case 'list': {
      const states: DirectiveState[] | undefined = options.all
        ? undefined
        : ['scheduled', 'active'];
      const list = await service.list({
        ...(options.scenario === undefined ? {} : { scenarioId: options.scenario }),
        ...(states === undefined ? {} : { states }),
      });
      if (list.length === 0) out(t('directives.none'));
      for (const d of list) out(lineOf(d));
      return EXIT_OK;
    }
    case 'show': {
      const found = await service.get(first ?? '');
      if (found === undefined) return missing(first ?? '');
      out(JSON.stringify(summarizeDirective(found), null, 2));
      return EXIT_OK;
    }
    case 'add':
    case 'suspend': {
      const suspending = action === 'suspend';
      const input: DirectiveInput = {
        text: suspending
          ? (rest[0] ?? t('directives.suspendText', { id: first ?? '' }))
          : (first ?? ''),
        scope: options.scenario === undefined ? 'global' : 'local',
        ...(options.scenario === undefined ? {} : { scenarioId: options.scenario }),
        kind: suspending ? 'suspension' : ((options.kind as Kind | undefined) ?? undefined),
        ...(options.role.length === 0 ? {} : { roles: options.role }),
        ...(options.ruleKey === undefined ? {} : { ruleKey: options.ruleKey }),
        ...(options.ruleValue === undefined ? {} : { ruleValue: ruleValueOf(options.ruleValue) }),
        suspendsId: suspending ? (first ?? null) : (options.suspends ?? null),
        ...(options.replaces === undefined ? {} : { replacesId: options.replaces }),
        validity: validityOf(options),
      };
      const created = await service.create(input, 'terminal');
      out(t('directives.created', { id: created.id, state: created.state }));
      return EXIT_OK;
    }
    case 'extend': {
      const validity: ValidityText = {
        ...validityOf(options),
        ...(options.forever ? { until: null } : {}),
      };
      const extended = await service.extend(first ?? '', validity);
      out(t('directives.extended', { id: extended.id, state: extended.state }));
      return EXIT_OK;
    }
    case 'revoke': {
      const revoked = await service.revoke(first ?? '', (options.reason ?? '').trim());
      out(t('directives.revoked', { id: revoked.id }));
      return EXIT_OK;
    }
  }
}
