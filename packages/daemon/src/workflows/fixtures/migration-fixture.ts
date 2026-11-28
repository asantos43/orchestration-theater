// SPDX-License-Identifier: MPL-2.0
// Test only (excluded from the build): the versions of a workflow the migration tests move runs between.

/**
 * `ticket` 2.0.0: `announce -> review (approval) -> publish (call_tool) -> wait (wait_event)`, with
 * one limited loop (`wait -> publish`, key `redo`). It uses only generic step types, so it runs on
 * the `WorkflowRuntime` (the play does not: its migration is P10c).
 */
export function ticketV20(): Record<string, unknown> {
  return {
    id: 'ticket',
    version: '2.0.0',
    engine: '>=1 <2',
    inputs: { who: { type: 'string', default: 'world' } },
    limits: { redo: 2 },
    nodes: {
      announce: { step: 'notify', params: { message: 'ticket opened' } },
      review: { step: 'approval', params: { prompt: 'Publish?' } },
      publish: { step: 'call_tool', params: { tool: 'demo__write', args: { id: 'doc-1' } } },
      wait: { step: 'wait_event', params: { event: 'demo.ready', timeout: '1m' } },
    },
    edges: [
      'announce -> review',
      'review -> publish when output.approved',
      'review -> cancelled',
      'publish -> wait when output.ok',
      'publish -> failed',
      'wait -> done when not output.timed_out',
      { from: 'wait', to: 'publish', when: 'output.timed_out', limit: 'redo' },
      'wait -> failed',
    ],
  };
}

/**
 * `ticket` 2.1.0: `publish` is now `ship`, and a `notice` step is new. It says where each node of
 * 2.0.0 goes (`migrate_from`), so a run of 2.0.0 can move to it at a safe point.
 */
export function ticketV21(): Record<string, unknown> {
  return {
    id: 'ticket',
    version: '2.1.0',
    engine: '>=1 <2',
    inputs: { who: { type: 'string', default: 'world' } },
    limits: { redo: 2 },
    migrate_from: {
      '2.0.0': { announce: 'announce', review: 'review', publish: 'ship', wait: 'wait' },
    },
    nodes: {
      announce: { step: 'notify', params: { message: 'ticket opened' } },
      review: { step: 'approval', params: { prompt: 'Publish?' } },
      ship: { step: 'call_tool', params: { tool: 'demo__write', args: { id: 'doc-1' } } },
      notice: { step: 'notify', params: { message: 'shipped' } },
      wait: { step: 'wait_event', params: { event: 'demo.ready', timeout: '1m' } },
    },
    edges: [
      'announce -> review',
      'review -> ship when output.approved',
      'review -> cancelled',
      'ship -> notice when output.ok',
      'ship -> failed',
      'notice -> wait',
      'wait -> done when not output.timed_out',
      { from: 'wait', to: 'ship', when: 'output.timed_out', limit: 'redo' },
      'wait -> failed',
    ],
  };
}

/** 2.2.0: valid, but it does not say where a run of 2.0.0 goes (no `migrate_from`). */
export function ticketV22NoMapping(): Record<string, unknown> {
  const definition = ticketV21();
  delete definition.migrate_from;
  return { ...definition, version: '2.2.0' };
}

/** 2.3.0: maps `announce`, `review` and `wait` of 2.0.0 but not `publish`. */
export function ticketV23Partial(): Record<string, unknown> {
  return {
    ...ticketV21(),
    version: '2.3.0',
    migrate_from: { '2.0.0': { announce: 'announce', review: 'review', wait: 'wait' } },
  };
}

/** 2.4.0: maps everything, but asks for an input a run of 2.0.0 does not have. */
export function ticketV24NewInput(): Record<string, unknown> {
  return {
    ...ticketV21(),
    version: '2.4.0',
    inputs: {
      who: { type: 'string', default: 'world' },
      reviewer: { type: 'string', required: true },
    },
  };
}

/** 2.5.0: renames the loop key (`redo` becomes `again`): the counter of 2.0.0 is dropped on migration. */
export function ticketV25RenamedLimit(): Record<string, unknown> {
  const definition = ticketV21();
  return {
    ...definition,
    version: '2.5.0',
    limits: { again: 2 },
    edges: (definition.edges as unknown[]).map((edge) =>
      typeof edge === 'object' && edge !== null && 'limit' in edge
        ? { ...edge, limit: 'again' }
        : edge,
    ),
  };
}
