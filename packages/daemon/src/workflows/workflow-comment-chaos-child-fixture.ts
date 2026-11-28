// SPDX-License-Identifier: MPL-2.0
// Shared by the `kill -9` test of the `comment` step only (excluded from the build of the package).

/**
 * The program of the child process of `comment.chaos.test.ts` (an ES module, run with `node`; the
 * test writes it to its run folder). It imports the compiled packages, so `tsc -b` comes first. It is
 * a small daemon: an on-disk SQLite store, the workflow runtime over it with the code host steps,
 * a prompt queue that answers `Allow` at once, and a tracker whose comments are JSON lines appended
 * (with `fsync`) to the file `OT_CHILD_WORLD`: the world outside the process, which a kill cannot
 * take back. `findComment` reads that file, which is what a tracker that lists comments gives the
 * verifier in the real daemon. What it takes from the environment:
 * - `OT_CHILD_MODE`: `first` starts the run `run-1`; `resume` resumes the runs that are open;
 * - `OT_CHILD_DB`, `OT_CHILD_WORLD`: the store and the world;
 * - `OT_CHILD_DAEMON_DIST`, `OT_CHILD_STORE_MODULE`: where the compiled code is (a file URL for the store);
 * - `OT_CHILD_CRASH_POINT`: the name of an `effects.*` point of `chaos/crash-points.ts`, at the effect
 *   `workflow.comment`; with no `onCrash` the process writes `CRASHPOINT <json>` and kills itself
 *   with `SIGKILL` there;
 * - `OT_CHILD_FINDER`: `off` leaves the verifier without `findComment` (the comment is then ambiguous).
 * On a normal end it prints `FINAL <state of run-1>` and `COMMENTS <number of comments>`.
 */
export const COMMENT_CHILD_SCRIPT = String.raw`
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const env = process.env;
const dist = env.OT_CHILD_DAEMON_DIST;
const { SqliteStore } = await import(env.OT_CHILD_STORE_MODULE);
const { WorkflowRuntime } = await import(pathToFileURL(dist + '/workflows/runtime.js').href);
const { registerWorkflowEffects } = await import(pathToFileURL(dist + '/workflows/effects.js').href);
const { GENERIC_STEP_RUNNERS, CODE_HOST_STEP_RUNNERS } = await import(
  pathToFileURL(dist + '/workflows/steps/index.js').href
);
const { registerCodeHostEffects } = await import(
  pathToFileURL(dist + '/workflows/steps/codehost/index.js').href
);
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

const comments = () =>
  existsSync(env.OT_CHILD_WORLD)
    ? readFileSync(env.OT_CHILD_WORLD, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
    : [];

const issueTracker = {
  async commentOnIssue({ number, body }) {
    const id = 'comment-' + String(comments().length + 1);
    appendFileSync(env.OT_CHILD_WORLD, JSON.stringify({ id, number, body }) + '\n');
    const fd = openSync(env.OT_CHILD_WORLD, 'r');
    fsyncSync(fd);
    closeSync(fd);
    return { id, url: 'https://example.test/issues/' + String(number) + '#' + id };
  },
};

const findComment =
  env.OT_CHILD_FINDER === 'off'
    ? undefined
    : async ({ number, marker }) => {
        const found = comments().find((comment) => comment.number === number && comment.body.includes(marker));
        return found === undefined ? undefined : { id: found.id, url: 'https://example.test/issues/' + String(number) + '#' + found.id };
      };

const definition = {
  id: 'comment-flow',
  version: '1.0.0',
  engine: '>=1 <2',
  inputs: { issue: { type: 'number', required: false } },
  nodes: {
    ask: { step: 'approval', params: { prompt: 'Comment?' } },
    say: { step: 'comment', params: { target: 'issue', body: 'Looks fine.' } },
  },
  edges: ['ask -> say when output.approved', 'ask -> cancelled', 'say -> done'],
};

const store = await SqliteStore.open({ path: env.OT_CHILD_DB }, clock);
const pluginEffects = new PluginEffectRegistry();
registerWorkflowEffects(pluginEffects, store);
registerCodeHostEffects(pluginEffects, { findComment });

const runtime = new WorkflowRuntime({
  store,
  clock,
  pluginEffects,
  steps: [...GENERIC_STEP_RUNNERS, ...CODE_HOST_STEP_RUNNERS],
  ask: async () => ({ decisionId: 'decision-' + String(Date.now()), answer: Promise.resolve('Allow') }),
  codeHost: {
    codeHost: {},
    issueTracker,
    repoOf: () => '/repo',
    security: {
      requireApproval: ['push', 'comment', 'label'],
      untrustedText: 'mark_and_truncate',
      untrustedMaxChars: 20000,
      commentMarker: 'on',
    },
    findComment,
  },
  source: { resolve: ({ id, version }) => (id === definition.id && version === definition.version ? definition : undefined) },
});

if (env.OT_CHILD_MODE === 'first') {
  if (env.OT_CHILD_CRASH_POINT) {
    armFaults({ crash: [{ point: env.OT_CHILD_CRASH_POINT, detail: 'workflow.comment', nth: 1 }], fail: [] });
  }
  const started = await runtime.start({ runId: 'run-1', scenarioId: 'scenario-1', definition, inputs: { issue: 7 } });
  if (!started.ok) throw new Error('start refused: ' + JSON.stringify(started));
} else {
  const resumed = await runtime.resumeAll();
  console.log('RESUMED ' + JSON.stringify(resumed));
}
await runtime.idle();
const play = await store.plays.get('run-1');
console.log('FINAL ' + (play ? play.state : 'none'));
console.log('COMMENTS ' + String(comments().length));
await runtime.stop();
await store.close();
process.exit(0);
`;
