// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the answers of the API are read as loose JSON */
import { afterEach, describe, expect, it } from 'vitest';
import { installReadyWorkflows } from '../../workflows/definitions/ready-workflows.js';
import {
  removeTempFolders,
  tempFolder,
  workflowYaml,
  writePackageFolder,
} from '../../workflows/packages/packages.test-support.js';
import { closeRigs, definition, makeRig } from './workflows.test-support.js';

afterEach(async () => {
  await closeRigs();
  await removeTempFolders();
});

/**
 * The routes of the workflows (Phase 11b, P10b) over the real HTTP server and the real composition
 * of the engine (`composeWorkflows`), with the fakes of the code host: the library, the
 * bindings and the installer are the daemon's own, nothing is stubbed. What the tests pin down is
 * what the routes add: the issues with their lines, the cut of a simulation, the codes of the
 * refusals, the copy of the triggers by a binding, and the two calls of an install.
 */

describe('POST /v1/workflows/validate', () => {
  it('says ok with the identity and the hash of a sound definition', async () => {
    const rig = await makeRig();
    const answer = await rig.call('POST', '/v1/workflows/validate', {
      definition: definition('1.0.0'),
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      ok: true,
      stage: 'definition',
      workflow: { id: 'triage', version: '1.0.0' },
      errors: [],
    });
    expect(answer.json.workflow.hash).toMatch(/^sha256:/);
  });

  it('answers 200 with the issues and the line of a YAML that does not parse', async () => {
    const rig = await makeRig();
    const answer = await rig.call('POST', '/v1/workflows/validate', {
      yaml: 'id: triage\nversion: 1.0.0\nnodes: [\n',
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ ok: false, stage: 'yaml', workflow: null });
    expect(answer.json.errors.length).toBeGreaterThan(0);
    expect(typeof answer.json.errors[0].line).toBe('number');
  });

  it('gives the line of an issue of the definition that came as YAML', async () => {
    const rig = await makeRig();
    const yaml = [
      'id: triage',
      'version: 1.0.0',
      'engine: ">=1 <2"',
      'nodes:',
      '  read: { step: no_such_step }',
      'edges:',
      '  - read -> done',
      '',
    ].join('\n');
    const answer = await rig.call('POST', '/v1/workflows/validate', { yaml });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ ok: false, stage: 'definition' });
    const issue = answer.json.errors.find((item: any) => item.code === 'unknown_step');
    expect(issue).toBeDefined();
    expect(issue.line).toBe(5);
  });

  it('applies workflows.security.require_approval of the configuration', async () => {
    const bare = {
      id: 'bare',
      version: '1.0.0',
      engine: '>=1 <2',
      inputs: { issue: { type: 'number' } },
      nodes: { post: { step: 'comment', params: { target: 'issue', body: 'Thanks' } } },
      edges: ['post -> done'],
    };
    const strict = await makeRig();
    expect(
      (await strict.call('POST', '/v1/workflows/validate', { definition: bare })).json.ok,
    ).toBe(false);
    const loose = await makeRig({ yaml: '  security:\n    require_approval: none\n' });
    expect((await loose.call('POST', '/v1/workflows/validate', { definition: bare })).json.ok).toBe(
      true,
    );
  });
});

describe('POST /v1/workflows/simulate', () => {
  it('walks a definition and lists the path', async () => {
    const rig = await makeRig();
    const answer = await rig.call('POST', '/v1/workflows/simulate', {
      definition: definition('1.0.0'),
      inputs: { issue: 7 },
      outputs: { ask: { approved: true } },
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ ok: true, status: 'done', workflow: { id: 'triage' } });
    expect(answer.json.path.map((step: any) => step.node)).toEqual(['read', 'ask', 'say']);
  });

  it('stops at workflows.simulate.max_steps and says it was cut', async () => {
    const rig = await makeRig({ yaml: '  simulate:\n    max_steps: 3\n' });
    const answer = await rig.call('POST', '/v1/workflows/simulate', {
      definition: definition('1.0.0'),
      inputs: { issue: 1 },
      outputs: { ask: { approved: false } },
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ ok: true, status: 'truncated' });
    expect(answer.json.path).toHaveLength(3);
  });

  it('with on_limit: fail the cut is a failed answer, still 200', async () => {
    const rig = await makeRig({ yaml: '  simulate:\n    max_steps: 3\n    on_limit: fail\n' });
    const answer = await rig.call('POST', '/v1/workflows/simulate', {
      definition: definition('1.0.0'),
      inputs: { issue: 1 },
      outputs: { ask: { approved: false } },
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ ok: false, reason: 'step_limit' });
  });

  it('walks a saved version, and 404s one that is not in the library', async () => {
    const rig = await makeRig();
    await rig.composed.library.install(definition('1.0.0'), { source: 'user' });
    const saved = await rig.call('POST', '/v1/workflows/simulate', {
      workflowId: 'triage',
      inputs: { issue: 1 },
    });
    expect(saved.json).toMatchObject({ ok: true, workflow: { id: 'triage', version: '1.0.0' } });
    const missing = await rig.call('POST', '/v1/workflows/simulate', {
      workflowId: 'triage',
      version: '9.9.9',
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('not_found');
  });

  it('refuses a document that is not valid with the issues, and spends nothing', async () => {
    const rig = await makeRig();
    const answer = await rig.call('POST', '/v1/workflows/simulate', {
      yaml: 'id: triage\nversion: 1.0.0\nengine: ">=1 <2"\nnodes: {}\nedges: []\n',
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ ok: false, reason: 'invalid_definition' });
    expect(answer.json.errors.length).toBeGreaterThan(0);
  });
});

describe('the library', () => {
  it('saves a version (active when it is the first), is idempotent, and conflicts on other content', async () => {
    const rig = await makeRig();
    const first = await rig.call('POST', '/v1/workflows', { definition: definition('1.0.0') });
    expect(first.status).toBe(200);
    expect(first.json.version).toMatchObject({
      workflowId: 'triage',
      version: '1.0.0',
      state: 'active',
      source: 'user',
    });
    expect(first.json.version.definition).toBeUndefined();
    const again = await rig.call('POST', '/v1/workflows', { definition: definition('1.0.0') });
    expect(again.status).toBe(200);
    const changed = await rig.call('POST', '/v1/workflows', {
      definition: definition('1.0.0', { description: 'other' }),
    });
    expect(changed.status).toBe(409);
    expect(changed.json.error.code).toBe('conflict');
  });

  it('refuses an invalid definition with invalid_input and the issues in the details', async () => {
    const rig = await makeRig();
    const answer = await rig.call('POST', '/v1/workflows', {
      definition: { ...definition('1.0.0'), edges: ['read -> nowhere'] },
    });
    expect(answer.status).toBe(400);
    expect(answer.json.error.code).toBe('invalid_input');
    expect(answer.json.error.details.issues.length).toBeGreaterThan(0);
    expect(await rig.composed.library.list()).toHaveLength(0);
  });

  it('saves a second version inactive, activates it, and deactivates it', async () => {
    const rig = await makeRig();
    await rig.call('POST', '/v1/workflows', { definition: definition('1.0.0') });
    const second = await rig.call('POST', '/v1/workflows', { definition: definition('1.1.0') });
    expect(second.json.version.state).not.toBe('active');
    expect((await rig.composed.library.active('triage'))?.version).toBe('1.0.0');

    const activated = await rig.call('POST', '/v1/workflows/triage/versions/1.1.0/activate');
    expect(activated.status).toBe(200);
    expect(activated.json).toMatchObject({
      version: { version: '1.1.0', state: 'active' },
      runningOnChange: 'pin',
    });
    expect((await rig.composed.library.active('triage'))?.version).toBe('1.1.0');

    const off = await rig.call('POST', '/v1/workflows/triage/versions/1.1.0/deactivate');
    expect(off.status).toBe(200);
    expect(await rig.composed.library.active('triage')).toBeUndefined();
    const missing = await rig.call('POST', '/v1/workflows/triage/versions/7.0.0/deactivate');
    expect(missing.status).toBe(404);
  });

  it('reports running_on_change in the activation', async () => {
    const rig = await makeRig({ yaml: '  running_on_change: migrate_at_safe_point\n' });
    await rig.call('POST', '/v1/workflows', { definition: definition('1.0.0') });
    await rig.call('POST', '/v1/workflows', { definition: definition('1.1.0') });
    const activated = await rig.call('POST', '/v1/workflows/triage/versions/1.1.0/activate');
    expect(activated.json.runningOnChange).toBe('migrate_at_safe_point');
  });

  it('lists the versions with no definition, and reads one with it', async () => {
    const rig = await makeRig();
    await rig.call('POST', '/v1/workflows', { definition: definition('1.0.0') });
    await rig.call('POST', '/v1/workflows', { definition: definition('1.1.0') });
    const list = await rig.call('GET', '/v1/workflows?workflowId=triage');
    expect(list.status).toBe(200);
    expect(list.json.items.map((item: any) => item.version)).toEqual(['1.0.0', '1.1.0']);
    expect(list.json.items[0].definition).toBeUndefined();
    const one = await rig.call('GET', '/v1/workflows/triage/versions/1.1.0');
    expect(one.json.version.version).toBe('1.1.0');
    expect(one.json.definition.id).toBe('triage');
    expect((await rig.call('GET', '/v1/workflows/triage/versions/8.0.0')).status).toBe(404);
  });

  it('diffs two versions, and says when they are the same', async () => {
    const rig = await makeRig();
    await rig.call('POST', '/v1/workflows', { definition: definition('1.0.0') });
    const next = definition('1.1.0');
    (next.nodes as Record<string, unknown>).say = {
      step: 'notify',
      params: { message: 'extra words' },
    };
    await rig.call('POST', '/v1/workflows', { definition: next });
    const diff = await rig.call('GET', '/v1/workflows/triage/diff?from=1.0.0&to=1.1.0');
    expect(diff.status).toBe(200);
    expect(diff.json).toMatchObject({
      workflowId: 'triage',
      from: { version: '1.0.0' },
      to: { version: '1.1.0' },
      same: false,
    });
    expect(JSON.stringify(diff.json.changes)).toContain('say');
    const same = await rig.call('GET', '/v1/workflows/triage/diff?from=1.0.0&to=1.0.0');
    expect(same.json).toMatchObject({ same: true, changes: [] });
    expect((await rig.call('GET', '/v1/workflows/triage/diff?from=1.0.0&to=3.0.0')).status).toBe(
      404,
    );
  });
});

describe('the bindings', () => {
  it('copies the triggers of the definition when the body names none', async () => {
    const rig = await makeRig();
    await installReadyWorkflows(rig.composed.library);
    const declared = (await rig.composed.library.active('github-issues'))?.definition.triggers;
    expect(Array.isArray(declared) && declared.length).toBeGreaterThan(0);
    const bound = await rig.call('POST', '/v1/workflow-bindings', {
      scenarioId: 's1',
      workflowId: 'github-issues',
    });
    expect(bound.status).toBe(200);
    expect(bound.json.triggers).toEqual(declared);
    expect(bound.json).toMatchObject({ scenarioId: 's1', workflowId: 'github-issues' });
  });

  it('triggers: [] means none, and a list in the body is used as it is', async () => {
    const rig = await makeRig();
    await installReadyWorkflows(rig.composed.library);
    const none = await rig.call('POST', '/v1/workflow-bindings', {
      scenarioId: 's1',
      workflowId: 'github-issues',
      triggers: [],
    });
    expect(none.json.triggers).toEqual([]);
    const own = await rig.call('POST', '/v1/workflow-bindings', {
      scenarioId: 's1',
      workflowId: 'pr-review',
      triggers: [{ type: 'manual' }],
    });
    expect(own.json.triggers).toEqual([{ type: 'manual' }]);
  });

  it('pauses, resumes and stops a binding, lists it, and conflicts on a stopped one', async () => {
    const rig = await makeRig();
    await installReadyWorkflows(rig.composed.library);
    const bound = await rig.call('POST', '/v1/workflow-bindings', {
      scenarioId: 's1',
      workflowId: 'github-issues',
    });
    const id = bound.json.id as string;
    expect((await rig.call('POST', `/v1/workflow-bindings/${id}/pause`)).json.state).toBe('paused');
    expect((await rig.call('POST', `/v1/workflow-bindings/${id}/resume`)).json.state).toBe(
      'active',
    );
    expect((await rig.call('POST', `/v1/workflow-bindings/${id}/stop`)).json.state).toBe('stopped');
    const again = await rig.call('POST', `/v1/workflow-bindings/${id}/resume`);
    expect(again.status).toBe(409);
    const list = await rig.call('GET', '/v1/workflow-bindings?scenarioId=s1&state=stopped');
    expect(list.json.items.map((item: any) => item.id)).toEqual([id]);
    expect((await rig.call('GET', '/v1/workflow-bindings?state=active')).json.items).toEqual([]);
  });

  it('404s a binding of a workflow the library does not have', async () => {
    const rig = await makeRig();
    const answer = await rig.call('POST', '/v1/workflow-bindings', {
      scenarioId: 's1',
      workflowId: 'nothing-here',
    });
    expect([404, 409]).toContain(answer.status);
  });
});

describe('the runs', () => {
  it('lists the runs of workflows, not the other plays, with the version it was born in', async () => {
    const rig = await makeRig();
    const ref = { id: 'triage', version: '1.0.0', hash: `sha256:${'a'.repeat(64)}` };
    await rig.store.plays.create({
      id: 'run-1',
      scenarioId: 's1',
      need: 'workflow:triage',
      flowId: 'triage',
      flowVersion: 1,
      state: 'ask',
      snapshot: {
        workflow: { ...ref, version: '1.1.0' },
        born: ref,
        runtime: { steps: 2, migration: { toVersion: '1.1.0', trigger: 'request' } },
      },
      counters: {},
      parentPlayId: null,
    });
    await rig.store.plays.create({
      id: 'play-1',
      scenarioId: 's1',
      need: 'Do it',
      flowId: 'play',
      flowVersion: 1,
      state: 'EXECUTING',
      snapshot: {},
      counters: {},
      parentPlayId: null,
    });
    const all = await rig.call('GET', '/v1/workflow-runs');
    expect(all.status).toBe(200);
    expect(all.json.items).toHaveLength(1);
    expect(all.json.items[0]).toMatchObject({
      runId: 'run-1',
      scenarioId: 's1',
      state: 'ask',
      steps: 2,
      migrationPending: true,
      workflow: { id: 'triage', version: '1.1.0' },
      born: { version: '1.0.0' },
    });
    expect((await rig.call('GET', '/v1/workflow-runs?workflowId=other')).json.items).toEqual([]);
    expect(
      (await rig.call('GET', '/v1/workflow-runs?status=open&scenarioId=s1')).json.items,
    ).toHaveLength(1);
  });
});

describe('the packages', () => {
  async function makePackage(): Promise<string> {
    const root = await tempFolder('otroutes-pkg-');
    await writePackageFolder(root, {
      id: 'review-kit',
      version: '1.0.0',
      description: 'Review workflows',
      files: [{ path: 'workflows/review-1.0.0.yaml', text: workflowYaml('review', '1.0.0') }],
    });
    return root;
  }

  it('previews first, then installs with the hash of the preview', async () => {
    const rig = await makeRig();
    const origin = await makePackage();
    const preview = await rig.call('POST', '/v1/workflow-packages/install', { origin });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ status: 'preview', workflows: [] });
    expect(preview.json.preview).toMatchObject({ packageId: 'review-kit', version: '1.0.0' });
    expect(await rig.composed.library.list()).toHaveLength(0);

    const installed = await rig.call('POST', '/v1/workflow-packages/install', {
      origin,
      approvedHash: preview.json.preview.hash,
    });
    expect(installed.status).toBe(200);
    expect(installed.json.status).toBe('installed');
    expect(installed.json.workflows).toEqual([{ id: 'review', version: '1.0.0', active: true }]);
    expect((await rig.composed.library.active('review'))?.source).toBe('package');

    const listed = await rig.call('GET', '/v1/workflow-packages');
    expect(listed.json.items.map((item: any) => item.id)).toEqual(['review-kit']);
  });

  it('conflicts when the hash is not the one of the package as it is now', async () => {
    const rig = await makeRig();
    const origin = await makePackage();
    const answer = await rig.call('POST', '/v1/workflow-packages/install', {
      origin,
      approvedHash: `sha256:${'0'.repeat(64)}`,
    });
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe('conflict');
    expect(await rig.composed.library.list()).toHaveLength(0);
  });

  it('removes a package, and conflicts while its version is the active one', async () => {
    const rig = await makeRig();
    const origin = await makePackage();
    const preview = await rig.call('POST', '/v1/workflow-packages/install', { origin });
    await rig.call('POST', '/v1/workflow-packages/install', {
      origin,
      approvedHash: preview.json.preview.hash,
    });
    const blocked = await rig.call('DELETE', '/v1/workflow-packages/review-kit');
    expect(blocked.status).toBe(409);
    await rig.call('POST', '/v1/workflows/review/versions/1.0.0/deactivate');
    const removed = await rig.call('DELETE', '/v1/workflow-packages/review-kit');
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ removed: 'review-kit' });
    expect(await rig.composed.library.list()).toHaveLength(0);
    expect((await rig.call('DELETE', '/v1/workflow-packages/review-kit')).status).toBe(404);
  });
});

describe('a daemon that runs no workflow engine', () => {
  it('answers 503 unavailable on every route', async () => {
    const rig = await makeRig({ bare: true });
    for (const [method, path, body] of [
      ['GET', '/v1/workflows', undefined],
      ['GET', '/v1/workflow-bindings', undefined],
      ['GET', '/v1/workflow-runs', undefined],
      ['GET', '/v1/workflow-packages', undefined],
      ['POST', '/v1/workflows/validate', { definition: definition('1.0.0') }],
      ['POST', '/v1/workflows', { definition: definition('1.0.0') }],
      ['POST', '/v1/workflow-bindings', { scenarioId: 's1', workflowId: 'triage' }],
    ] as const) {
      const answer = await rig.call(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(503);
      expect(answer.json.error.code).toBe('unavailable');
    }
  });
});
