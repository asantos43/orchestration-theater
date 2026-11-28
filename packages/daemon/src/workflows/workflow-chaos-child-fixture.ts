// SPDX-License-Identifier: MPL-2.0
// Shared by the `kill -9` test of the workflow runtime only (excluded from the build of the package).

/**
 * The program of the child process of `call-tool.chaos.test.ts` (an ES module, run with `node`; the
 * test writes it to its run folder). It imports the compiled packages, so `pnpm build` comes first.
 * It is a small daemon: an on-disk SQLite store, the workflow runtime over it, and one tool, `demo__write`,
 * whose effect is a line appended (with `fsync`) to the file `OT_CHILD_WORLD`: the world outside the
 * process, which a kill cannot take back. What it takes from the environment:
 * - `OT_CHILD_MODE`: `first` starts the run `run-1`; `resume` starts the runtime and resumes the runs
 *   that are open (what the daemon does at boot);
 * - `OT_CHILD_DB`, `OT_CHILD_WORLD`: the store and the world;
 * - `OT_CHILD_DAEMON_DIST`, `OT_CHILD_STORE_MODULE`: where the compiled code is (a file URL for the store);
 * - `OT_CHILD_CRASH_POINT`: the name of an `effects.*` point of `chaos/crash-points.ts`; with no
 *   `onCrash` the process writes `CRASHPOINT <json>` and kills itself with `SIGKILL` there.
 * On a normal end it prints `FINAL <state of run-1>` and `WORLD <number of lines>`.
 */
export const WORKFLOW_CHILD_SCRIPT = String.raw`
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const env = process.env;
const dist = env.OT_CHILD_DAEMON_DIST;
const { SqliteStore } = await import(env.OT_CHILD_STORE_MODULE);
const { WorkflowRuntime } = await import(pathToFileURL(dist + '/workflows/runtime.js').href);
const { registerWorkflowEffects } = await import(pathToFileURL(dist + '/workflows/effects.js').href);
const { PluginEffectRegistry } = await import(pathToFileURL(dist + '/workspace/plugin-effects.js').href);
const { armFaults } = await import(pathToFileURL(dist + '/chaos/crash-points.js').href);

const clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    }),
};

const world = () =>
  existsSync(env.OT_CHILD_WORLD)
    ? readFileSync(env.OT_CHILD_WORLD, 'utf8').split('\n').filter((line) => line !== '')
    : [];

const tools = {
  find: (_project, name) =>
    name === 'demo__write' ? { plugin: 'demo', tool: 'write', effects: 'external_write' } : undefined,
  async call(_project, _ref, args) {
    appendFileSync(env.OT_CHILD_WORLD, args.id + '\n');
    const fd = openSync(env.OT_CHILD_WORLD, 'r');
    fsyncSync(fd);
    closeSync(fd);
    return { ok: true, result: { wrote: args.id } };
  },
};

const definition = {
  id: 'save-only',
  version: '1.0.0',
  engine: '>=1 <2',
  nodes: { save: { step: 'call_tool', params: { tool: 'demo__write', args: { id: 'doc-9' } } } },
  edges: ['save -> done'],
};

const store = await SqliteStore.open({ path: env.OT_CHILD_DB }, clock);
const pluginEffects = new PluginEffectRegistry();
pluginEffects.register('demo', {
  type: 'demo.write',
  verify: async (record) => {
    const id = record.params?.args?.id;
    return world().includes(id)
      ? { verdict: 'done', result: { ok: true, result: { wrote: id } } }
      : { verdict: 'not_done' };
  },
});
registerWorkflowEffects(pluginEffects, store);

const runtime = new WorkflowRuntime({
  store,
  clock,
  tools,
  pluginEffects,
  source: { resolve: ({ id, version }) => (id === definition.id && version === definition.version ? definition : undefined) },
});

if (env.OT_CHILD_MODE === 'first') {
  if (env.OT_CHILD_CRASH_POINT) {
    armFaults({ crash: [{ point: env.OT_CHILD_CRASH_POINT, detail: 'demo.write', nth: 1 }], fail: [] });
  }
  const started = await runtime.start({ runId: 'run-1', scenarioId: 'scenario-1', definition });
  if (!started.ok) throw new Error('start refused: ' + JSON.stringify(started));
} else {
  const resumed = await runtime.resumeAll();
  console.log('RESUMED ' + JSON.stringify(resumed));
}
await runtime.idle();
const play = await store.plays.get('run-1');
console.log('FINAL ' + (play ? play.state : 'none'));
console.log('WORLD ' + String(world().length));
await runtime.stop();
await store.close();
process.exit(0);
`;
