// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '@otheater/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRigs, definition, makeRig, type Rig } from '../api/routes/workflows.test-support.js';
import { main } from '../cli.js';
import { createTranslator } from '../i18n.js';
import { installReadyWorkflows } from '../workflows/definitions/ready-workflows.js';
import {
  removeTempFolders,
  tempFolder,
  workflowYaml,
  writePackageFolder,
} from '../workflows/packages/packages.test-support.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../commands.js';
import {
  FLOW_ACTIONS,
  isFlowAction,
  runFlowCommand,
  type FlowAction,
  type FlowOptions,
} from './flow.js';

/**
 * `ot flow` (Phase 11b, P10b) against the real routes and the real composition of the engine
 * (`workflows.test-support.ts`), through the client of `@otheater/client`: what each action sends,
 * what it prints, and the exit code. No network beyond the loopback, no executor, no real client.
 */

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'otflow-'));
});
afterEach(async () => {
  await closeRigs();
  await removeTempFolders();
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NO_OPTIONS: FlowOptions = { json: false, fail: [], activate: false };

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function flow(
  rig: Rig,
  action: FlowAction,
  args: readonly string[],
  options: Partial<FlowOptions> = {},
  locale: 'en' | 'pt-BR' = 'en',
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFlowCommand(
    {
      dataDir: folder,
      t: await createTranslator(locale),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    { client: new ApiClient({ url: rig.server.url, token: rig.token }) },
    action,
    args,
    { ...NO_OPTIONS, ...options },
  );
  return { code, out, err };
}

async function file(name: string, content: unknown): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

describe('the actions', () => {
  it('knows the twelve actions of the plan', () => {
    expect([...FLOW_ACTIONS].sort()).toEqual(
      'activate bind deactivate diff install list pause resume save simulate stop validate'.split(
        ' ',
      ),
    );
    expect(isFlowAction('save')).toBe(true);
    expect(isFlowAction('delete')).toBe(false);
  });
});

describe('ot flow validate', () => {
  it('says ok with the identity and the hash, from a file of JSON (a YAML too)', async () => {
    const rig = await makeRig();
    const run = await flow(rig, 'validate', [await file('triage.json', definition('1.0.0'))]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out[0]).toMatch(/^Valid: triage 1\.0\.0 \(hash sha256:/u);
    expect(run.err).toEqual([]);
  });

  it('exits 1 and prints each issue with its line', async () => {
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
    const run = await flow(rig, 'validate', [await file('bad.yaml', yaml)]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err[0]).toBe('Not valid: 1 problem(s).');
    expect(run.err.join('\n')).toMatch(/no_such_step/u);
    expect(run.err.join('\n')).toMatch(/\(line \d+\)/u);
  });

  it('says in Portuguese when the locale is pt-BR', async () => {
    const rig = await makeRig();
    const run = await flow(
      rig,
      'validate',
      [await file('t.json', definition('1.0.0'))],
      {},
      'pt-BR',
    );
    expect(run.out[0]).toMatch(/^Válido: triage 1\.0\.0/u);
  });

  it('exits 1 when the file cannot be read, without calling the daemon', async () => {
    const rig = await makeRig();
    const run = await flow(rig, 'validate', [join(folder, 'missing.yaml')]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err[0]).toMatch(/^Cannot read .*missing\.yaml: /u);
  });

  it('prints JSON with --json', async () => {
    const rig = await makeRig();
    const run = await flow(rig, 'validate', [await file('t.json', definition('1.0.0'))], {
      json: true,
    });
    expect(JSON.parse(run.out.join('\n'))).toMatchObject({ ok: true, workflow: { id: 'triage' } });
  });
});

describe('ot flow simulate', () => {
  it('walks a file with the inputs and the outputs given, and lists the steps', async () => {
    const rig = await makeRig();
    const run = await flow(rig, 'simulate', [await file('t.json', definition('1.0.0'))], {
      input: '{"issue":7}',
      outputs: '{"ask":{"approved":true}}',
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.out[0]).toMatch(/^Simulation of triage 1\.0\.0: done/u);
    expect(run.out.filter((line) => /^\d+\. /u.test(line))).toHaveLength(3);
    expect(run.out.join('\n')).toMatch(/1\. read \(fetch_issue\) -> ask via/u);
  });

  it('walks a saved version by id and by id@version, and exits 1 when it is not there', async () => {
    const rig = await makeRig();
    await rig.composed.library.install(definition('1.0.0'), { source: 'user' });
    const byId = await flow(rig, 'simulate', ['triage'], { input: '{"issue":1}' });
    expect(byId.code).toBe(EXIT_OK);
    expect(byId.out[0]).toMatch(/^Simulation of triage 1\.0\.0/u);
    const byVersion = await flow(rig, 'simulate', ['triage@1.0.0'], { input: '{"issue":1}' });
    expect(byVersion.code).toBe(EXIT_OK);
    const missing = await flow(rig, 'simulate', ['triage@9.9.9']);
    expect(missing.code).toBe(EXIT_FAILED);
    expect(missing.err[0]).toMatch(/^The daemon refused \(not_found\): /u);
  });

  it('says the walk was cut at workflows.simulate.max_steps, and still exits 0', async () => {
    const rig = await makeRig({ yaml: '  simulate:\n    max_steps: 3\n' });
    const run = await flow(rig, 'simulate', [await file('t.json', definition('1.0.0'))], {
      input: '{"issue":1}',
      outputs: '{"ask":{"approved":false}}',
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join('\n')).toMatch(/workflows\.simulate\.max_steps/u);
  });

  it('exits 1 on a refused simulation (on_limit: fail), with the reason', async () => {
    const rig = await makeRig({ yaml: '  simulate:\n    max_steps: 3\n    on_limit: fail\n' });
    const run = await flow(rig, 'simulate', [await file('t.json', definition('1.0.0'))], {
      input: '{"issue":1}',
      outputs: '{"ask":{"approved":false}}',
    });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err[0]).toMatch(/^Nothing to simulate \(step_limit\)/u);
  });

  it('refuses a definition that is not valid, with the issues', async () => {
    const rig = await makeRig();
    const run = await flow(rig, 'simulate', [
      await file(
        'bad.yaml',
        'id: triage\nversion: 1.0.0\nengine: ">=1 <2"\nnodes: {}\nedges: []\n',
      ),
    ]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err[0]).toMatch(/invalid_definition/u);
    expect(run.err.length).toBeGreaterThan(1);
  });

  it('is a wrong usage when --input is not a JSON object, before any call', async () => {
    const rig = await makeRig();
    const bad = await flow(rig, 'simulate', ['triage'], { input: '[1]' });
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.err[0]).toBe('Option --input: a JSON object is needed');
    const notJson = await flow(rig, 'simulate', ['triage'], { outputs: '{oops' });
    expect(notJson.code).toBe(EXIT_USAGE);
    expect(notJson.err[0]).toMatch(/^Option --outputs: not valid JSON/u);
  });
});

describe('ot flow save, activate, deactivate, diff and list', () => {
  it('saves a version (active when the first), then a second one, which is active with --activate', async () => {
    const rig = await makeRig();
    const first = await flow(rig, 'save', [await file('v1.json', definition('1.0.0'))]);
    expect(first.code).toBe(EXIT_OK);
    expect(first.out[0]).toBe('Saved triage 1.0.0 (active).');
    const second = await flow(rig, 'save', [await file('v2.json', definition('1.1.0'))]);
    expect(second.out[0]).toBe('Saved triage 1.1.0 (inactive).');
    const third = await flow(rig, 'save', [await file('v3.json', definition('1.2.0'))], {
      activate: true,
    });
    expect(third.out[0]).toBe('Saved triage 1.2.0 (active).');
    expect((await rig.composed.library.active('triage'))?.version).toBe('1.2.0');
  });

  it('exits 1 with the issues when the definition does not validate', async () => {
    const rig = await makeRig();
    const run = await flow(rig, 'save', [
      await file(
        'bad.yaml',
        'id: triage\nversion: 1.0.0\nengine: ">=1 <2"\nnodes: {}\nedges: []\n',
      ),
    ]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err[0]).toMatch(/^The daemon refused \(invalid_input\)/u);
    expect(run.err.length).toBeGreaterThan(1);
  });

  it('activates and deactivates, by <id> <version> and by <id>@<version>', async () => {
    const rig = await makeRig();
    await rig.composed.library.install(definition('1.0.0'), { source: 'user' });
    await rig.composed.library.install(definition('1.1.0'), { source: 'user' });
    const activated = await flow(rig, 'activate', ['triage', '1.1.0']);
    expect(activated.code).toBe(EXIT_OK);
    expect(activated.out[0]).toBe(
      'Activated triage 1.1.0. Runs in progress: stay on the version they were born in.',
    );
    expect((await rig.composed.library.active('triage'))?.version).toBe('1.1.0');
    const deactivated = await flow(rig, 'deactivate', ['triage@1.1.0']);
    expect(deactivated.out[0]).toBe(
      'Deactivated triage 1.1.0. The workflow has no active version now.',
    );
    expect(await rig.composed.library.active('triage')).toBeUndefined();
    const missing = await flow(rig, 'activate', ['triage', '9.9.9']);
    expect(missing.code).toBe(EXIT_FAILED);
  });

  it('says in the mode of workflows.running_on_change what happens to the runs in progress', async () => {
    const rig = await makeRig({ yaml: '  running_on_change: migrate_at_safe_point\n' });
    await rig.composed.library.install(definition('1.0.0'), { source: 'user' });
    const run = await flow(rig, 'activate', ['triage', '1.0.0']);
    expect(run.out[0]).toMatch(/move to the new version at a safe point/u);
  });

  it('shows what changed between two versions, and that two equal ones are the same', async () => {
    const rig = await makeRig();
    await rig.composed.library.install(definition('1.0.0'), { source: 'user' });
    await rig.composed.library.install(
      definition('1.1.0', {
        nodes: {
          read: { step: 'fetch_issue' },
          ask: { step: 'approval', params: { prompt: 'ok?' } },
          say: { step: 'notify', params: { message: 'changed' } },
        },
      }),
      { source: 'user' },
    );
    const run = await flow(rig, 'diff', ['triage', '1.0.0', '1.1.0']);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out[0]).toMatch(/^triage: 1\.0\.0 -> 1\.1\.0, \d+ change\(s\)\./u);
    expect(run.out.join('\n')).toMatch(/changed/u);
    const same = await flow(rig, 'diff', ['triage', '1.0.0', '1.0.0']);
    expect(same.out[0]).toBe('triage: 1.0.0 and 1.0.0 are the same.');
  });

  it('lists the versions (default), with --state, and says when there is nothing', async () => {
    const rig = await makeRig();
    const none = await flow(rig, 'list', []);
    expect(none.out).toEqual(['Nothing to list.']);
    await rig.composed.library.install(definition('1.0.0'), { source: 'user' });
    await rig.composed.library.install(definition('1.1.0'), { source: 'user' });
    const all = await flow(rig, 'list', ['workflows']);
    expect(all.out).toEqual(['triage 1.0.0 [active] (user)', 'triage 1.1.0 [inactive] (user)']);
    const inactive = await flow(rig, 'list', [], { state: 'inactive' });
    expect(inactive.out).toEqual(['triage 1.1.0 [inactive] (user)']);
    const bad = await flow(rig, 'list', [], { state: 'weird' });
    expect(bad.code).toBe(EXIT_USAGE);
    expect(bad.err[0]).toBe('Option --state: use one of: active, inactive');
    const json = await flow(rig, 'list', [], { json: true, workflow: 'triage' });
    expect(JSON.parse(json.out.join('\n'))).toHaveLength(2);
  });

  it('is a wrong usage with the shape of the arguments when they are not right', async () => {
    const rig = await makeRig();
    const diff = await flow(rig, 'diff', ['triage', '1.0.0']);
    expect(diff.code).toBe(EXIT_USAGE);
    expect(diff.err[0]).toBe(
      'Wrong arguments for "ot flow diff". Use: ot flow diff <id> <from> <to>',
    );
    const kind = await flow(rig, 'list', ['nothing']);
    expect(kind.code).toBe(EXIT_USAGE);
    const noVersion = await flow(rig, 'activate', ['triage@']);
    expect(noVersion.code).toBe(EXIT_USAGE);
  });
});

describe('ot flow bind, pause, resume, stop and the lists of bindings and runs', () => {
  it('binds copying the triggers of the definition, then pauses, resumes and stops', async () => {
    const rig = await makeRig();
    await installReadyWorkflows(rig.composed.library);
    const declared = (await rig.composed.library.active('github-issues'))?.definition.triggers;
    const bound = await flow(rig, 'bind', ['s1', 'github-issues'], { budget: '5', period: 'day' });
    expect(bound.code, bound.err.join('\n')).toBe(EXIT_OK);
    const [binding] = await rig.composed.bindings.list();
    expect(binding?.triggers).toEqual(declared);
    expect(binding?.budgetUsd).toBe(5);
    expect(binding?.budgetPeriod).toBe('day');
    expect(bound.out[0]).toBe(
      `Binding ${String(binding?.id)}: github-issues ${String(binding?.versionRange)} in scenario s1 (${String(
        Array.isArray(declared) ? declared.length : 0,
      )} trigger(s), active).`,
    );
    const id = binding?.id ?? '';
    expect((await flow(rig, 'pause', [id])).out[0]).toBe(`Binding ${id} is paused.`);
    expect((await flow(rig, 'resume', [id])).out[0]).toBe(`Binding ${id} is active.`);
    expect((await flow(rig, 'stop', [id])).out[0]).toBe(`Binding ${id} is stopped.`);
    const again = await flow(rig, 'resume', [id]);
    expect(again.code).toBe(EXIT_FAILED);
    expect(again.err[0]).toMatch(/^The daemon refused \(conflict\)/u);
  });

  it('takes --triggers, --params, --until, --concurrency and --on-busy as the body of the binding', async () => {
    const rig = await makeRig();
    await installReadyWorkflows(rig.composed.library);
    const run = await flow(rig, 'bind', ['s1', 'pr-review'], {
      triggers: '[{"type":"manual"}]',
      params: '{"a":1}',
      until: '7d',
      concurrency: '2',
      onBusy: 'skip',
      range: '1.x',
    });
    expect(run.code, run.err.join('\n')).toBe(EXIT_OK);
    const [binding] = await rig.composed.bindings.list();
    expect(binding).toMatchObject({
      triggers: [{ type: 'manual' }],
      params: { a: 1 },
      concurrency: 2,
      onBusy: 'skip',
      versionRange: '1.x',
    });
    expect(binding?.until).not.toBeNull();
  });

  it('is a wrong usage on a bad option of the binding, before any call', async () => {
    const rig = await makeRig();
    expect((await flow(rig, 'bind', ['s1', 'x'], { triggers: '{}' })).err[0]).toBe(
      'Option --triggers: a JSON list of objects is needed',
    );
    expect((await flow(rig, 'bind', ['s1', 'x'], { budget: '-1' })).err[0]).toBe(
      'Option --budget: a positive number is needed',
    );
    expect((await flow(rig, 'bind', ['s1', 'x'], { concurrency: '1.5' })).err[0]).toBe(
      'Option --concurrency: a positive whole number is needed',
    );
    expect((await flow(rig, 'bind', ['s1', 'x'], { period: 'year' })).err[0]).toBe(
      'Option --period: use one of: day, week, month',
    );
    expect((await flow(rig, 'bind', ['s1', 'x'], { onBusy: 'wait' })).code).toBe(EXIT_USAGE);
    expect(await rig.composed.bindings.list()).toEqual([]);
  });

  it('lists the bindings with the budget, and the runs', async () => {
    const rig = await makeRig();
    await installReadyWorkflows(rig.composed.library);
    await flow(rig, 'bind', ['s1', 'github-issues'], { budget: '5', period: 'week' });
    const bindings = await flow(rig, 'list', ['bindings'], { scenario: 's1', state: 'active' });
    expect(bindings.out).toHaveLength(1);
    expect(bindings.out[0]).toMatch(/github-issues .* in s1; budget 5\.00 per week, spent 0\.00$/u);
    const none = await flow(rig, 'list', ['bindings'], { state: 'stopped' });
    expect(none.out).toEqual(['Nothing to list.']);
    const runs = await flow(rig, 'list', ['runs'], { state: 'open' });
    expect(runs.code).toBe(EXIT_OK);
    expect(runs.out).toEqual(['Nothing to list.']);
  });
});

describe('ot flow install', () => {
  async function makePackage(): Promise<string> {
    const root = await tempFolder('otflow-pkg-');
    await writePackageFolder(root, {
      id: 'review-kit',
      version: '1.0.0',
      description: 'Review workflows',
      files: [{ path: 'workflows/review-1.0.0.yaml', text: workflowYaml('review', '1.0.0') }],
    });
    return root;
  }

  it('previews without --approve (nothing installed), then installs with the hash it showed', async () => {
    const rig = await makeRig();
    const origin = await makePackage();
    const preview = await flow(rig, 'install', [origin]);
    expect(preview.code, preview.err.join('\n')).toBe(EXIT_OK);
    expect(preview.out[0]).toMatch(/^Package review-kit 1\.0\.0: 1 workflow\(s\), hash sha256:/u);
    expect(preview.out.join('\n')).toMatch(/Permissions: /u);
    expect(preview.out.join('\n')).toMatch(/Signature: /u);
    const hint = preview.out.find((line) => line.includes('--approve'));
    expect(hint).toBeDefined();
    expect(await rig.composed.library.list()).toHaveLength(0);

    const hash = /--approve (sha256:[0-9a-f]+)/u.exec(hint ?? '')?.[1] ?? '';
    const installed = await flow(rig, 'install', [origin], { approve: hash });
    expect(installed.code).toBe(EXIT_OK);
    expect(installed.out[0]).toBe('Package review-kit 1.0.0: installed.');
    expect(installed.out[1]).toBe('  review 1.0.0 (active)');
    const packages = await flow(rig, 'list', ['packages']);
    expect(packages.out[0]).toMatch(/^review-kit 1\.0\.0: review/u);
  });

  it('exits 1 on a hash that is not the one of the package as it is now', async () => {
    const rig = await makeRig();
    const origin = await makePackage();
    const run = await flow(rig, 'install', [origin], { approve: `sha256:${'0'.repeat(64)}` });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err[0]).toMatch(/^The daemon refused \(conflict\)/u);
    expect(await rig.composed.library.list()).toHaveLength(0);
  });
});

describe('ot flow through main()', () => {
  async function ot(argv: readonly string[]): Promise<Run> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...argv, '--data-dir', join(folder, 'data')], {
      env: { PATH: '/nowhere' },
      platform: 'linux',
      homedir: join(folder, 'home'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      systemLocale: 'en',
      version: '0.0.0-test',
    });
    return { code, out, err };
  }

  it('is a wrong usage without an action, or with an unknown one', async () => {
    const missing = await ot(['flow']);
    expect(missing.code).toBe(EXIT_USAGE);
    expect(missing.err[0]).toMatch(/^Missing action for "ot flow"/u);
    const unknown = await ot(['flow', 'delete']);
    expect(unknown.code).toBe(EXIT_USAGE);
    expect(unknown.err[0]).toMatch(/^Unknown action "delete" for "ot flow"/u);
  });

  it('is a wrong usage on wrong arguments, before it looks for the daemon', async () => {
    const run = await ot(['flow', 'diff', 'triage']);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toBe(
      'Wrong arguments for "ot flow diff". Use: ot flow diff <id> <from> <to>',
    );
  });

  it('says there is no daemon when none runs on the data folder, and exits 1', async () => {
    const run = await ot(['flow', 'list']);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err[0]).toMatch(/^No daemon is running/u);
  });

  it('parses the options of the command (repeated --fail, --on-busy) without a usage error', async () => {
    const run = await ot(['flow', 'simulate', 'x', '--fail', 'a', '--fail', 'b', '--input', '[1]']);
    // --input is checked before the daemon is looked for.
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err[0]).toBe('Option --input: a JSON object is needed');
  });

  it('shows the help of the command', async () => {
    const run = await ot(['flow', '--help']);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join('\n')).toContain('ot flow <action>');
    expect(run.out.join('\n')).toContain('--approve');
  });
});
