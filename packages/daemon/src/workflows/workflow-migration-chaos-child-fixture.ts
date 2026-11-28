// SPDX-License-Identifier: MPL-2.0
// Shared by the `kill -9` test of the migration only (excluded from the build of the package).

/**
 * The program of the child process of `migration.chaos.test.ts` (an ES module, run with `node`; the
 * test writes it to its run folder). It imports the compiled packages, so `pnpm build` comes first.
 * It is a small daemon: an on-disk SQLite store, the workflow runtime over it, and two tools:
 * `demo__write`, whose effect is a line appended (with `fsync`) to the file `OT_CHILD_WORLD` (the
 * world outside the process, which a kill cannot take back), and `demo__status`, which only reads
 * and is the "gate" of the generated pair: when the run calls it, the child asks the migration of the
 * run to the new version, from inside the step (so the request is always saved before the steps
 * after the gate, whatever the timing). What it takes from the environment:
 * - `OT_CHILD_MODE`: `first` starts the run `run-1`; `resume` starts the runtime and resumes the runs
 *   that are open (what the daemon does at boot);
 * - `OT_CHILD_DB`, `OT_CHILD_WORLD`: the store and the world;
 * - `OT_CHILD_DEFINITIONS`: a JSON file with `{from, to}`, the two versions of the generated pair;
 * - `OT_CHILD_DAEMON_DIST`, `OT_CHILD_STORE_MODULE`: where the compiled code is (a file URL for the store);
 * - `OT_CHILD_CRASH`: a JSON list of rules `{point, detail, nth}` of `chaos/crash-points.ts` (the
 *   `effects.*` points); with no `onCrash` the process writes `CRASHPOINT <json>` and kills itself
 *   with `SIGKILL` there;
 * - `OT_CHILD_STORE_CRASH`: `store.before_commit` or `store.after_commit`: the kill is at the commit of
 *   the transaction that writes `workflow.migrated` (the child tells the commit hooks which one it
 *   is, by watching the events the transactions append), not at the n-th commit of the process;
 * - `OT_CHILD_KILL_AFTER_REQUEST`: `1` kills the process inside the gate, right after the request was
 *   saved (so the run dies in 1.0.0 with a migration waiting).
 * On a normal end it prints `FINAL <state of run-1>` and `WORLD <number of lines>`.
 */
export const MIGRATION_CHILD_SCRIPT = String.raw`
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const env = process.env;
const dist = env.OT_CHILD_DAEMON_DIST;
const { SqliteStore } = await import(env.OT_CHILD_STORE_MODULE);
const { WorkflowRuntime } = await import(pathToFileURL(dist + '/workflows/runtime.js').href);
const { registerWorkflowEffects } = await import(pathToFileURL(dist + '/workflows/effects.js').href);
const { PluginEffectRegistry } = await import(pathToFileURL(dist + '/workspace/plugin-effects.js').href);
const { armFaults, crashPoint } = await import(pathToFileURL(dist + '/chaos/crash-points.js').href);

const definitions = JSON.parse(readFileSync(env.OT_CHILD_DEFINITIONS, 'utf8'));
const byVersion = new Map([
  [definitions.from.version, definitions.from],
  [definitions.to.version, definitions.to],
]);

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

let runtime;

const tools = {
  find: (_project, name) => {
    if (name === 'demo__write') return { plugin: 'demo', tool: 'write', effects: 'external_write' };
    if (name === 'demo__status') return { plugin: 'demo', tool: 'status', effects: 'read' };
    return undefined;
  },
  async call(_project, ref, args) {
    if (ref.tool === 'status') {
      // The gate: the Producer asks the migration while the run is in this step.
      const outcome = await runtime.requestMigration('run-1', definitions.to.version);
      if (outcome.status === 'refused') throw new Error('the request was refused: ' + JSON.stringify(outcome));
      if (env.OT_CHILD_KILL_AFTER_REQUEST === '1') {
        writeSync(1, 'CRASHPOINT ' + JSON.stringify({ point: 'workflow.after_request', hit: 1 }) + '\n');
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => undefined);
      }
      return { ok: true, result: { status: 'up' } };
    }
    appendFileSync(env.OT_CHILD_WORLD, args.id + '\n');
    const fd = openSync(env.OT_CHILD_WORLD, 'r');
    fsyncSync(fd);
    closeSync(fd);
    return { ok: true, result: { wrote: args.id } };
  },
};

// The commit hooks: told by the wrapper below that the transaction writes the migration event.
let migrating = false;
const storeCrash = env.OT_CHILD_STORE_CRASH;
const hooks = {
  beforeCommit: async () => {
    if (migrating && storeCrash === 'store.before_commit') await crashPoint('store.before_commit');
  },
  afterCommit: async () => {
    if (!migrating) return;
    migrating = false;
    if (storeCrash === 'store.after_commit') await crashPoint('store.after_commit');
  },
};

const store = await SqliteStore.open({ path: env.OT_CHILD_DB }, clock, hooks);
const realTransaction = store.transaction.bind(store);
store.transaction = (body) =>
  realTransaction((tx) =>
    body(
      new Proxy(tx, {
        get(target, name) {
          const value = Reflect.get(target, name);
          if (name !== 'events') return value;
          return new Proxy(value, {
            get(events, method) {
              const member = Reflect.get(events, method);
              if (typeof member !== 'function') return member;
              if (method !== 'append') return member.bind(events);
              return (event) => {
                if (event.type === 'workflow.migrated') migrating = true;
                return member.call(events, event);
              };
            },
          });
        },
      }),
    ),
  );

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

runtime = new WorkflowRuntime({
  store,
  clock,
  tools,
  pluginEffects,
  source: { resolve: ({ id, version }) => (id === definitions.from.id ? byVersion.get(version) : undefined) },
});

if (env.OT_CHILD_MODE === 'first') {
  const crash = [];
  if (env.OT_CHILD_CRASH) crash.push(...JSON.parse(env.OT_CHILD_CRASH));
  if (storeCrash) crash.push({ point: storeCrash, nth: 1 });
  if (crash.length > 0) armFaults({ crash, fail: [] });
  const started = await runtime.start({ runId: 'run-1', scenarioId: 'scenario-1', definition: definitions.from });
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
