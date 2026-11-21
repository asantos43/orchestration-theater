// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { usageSettingsOf } from '../usage/index.js';
import { describeWithLauncher } from '../launcher-fixture.js';
import { assertFakeAgentBuilt, waitFor, withPlayDaemon } from '../orchestration/e2e-fixture.js';
import { parseConfig } from '../config.js';
import { AtifExporter } from './atif-exporter.js';

/**
 * The trajectories the Harbor validator reads (Phase 8, P6, N215). The job `atif` of the CI sets
 * `OT_ATIF_OUT` to a folder and runs this test; `tools/atif-validate/run.sh` then passes what is in
 * `valid/` to the `TrajectoryValidator` of Harbor, which must accept every file, and what is in
 * `broken/` (copies broken on purpose), which must reject every one. Without `OT_ATIF_OUT` the test
 * is skipped: it writes files that only that job reads.
 *
 * `valid/<unit>-<content>/` holds the three units of `atif.export.unit` in both contents of
 * `atif.export.content`, from one play of the fake agent (the Director, the Actor and the Reviewer).
 */

const OUT = process.env.OT_ATIF_OUT;

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** The trajectory as loose JSON: the broken copies change it in ways its type forbids. */
interface Loose {
  schema_version: string;
  steps: {
    step_id: number;
    source: string;
    llm_call_count?: number;
    metrics?: unknown;
    observation?: { results: { subagent_trajectory_ref?: { trajectory_id: string }[] }[] };
  }[];
  subagent_trajectories: { trajectory_id?: string }[];
  [key: string]: unknown;
}

const UNITS = ['play', 'attempt', 'play_files'] as const;
const CONTENTS = ['full', 'redacted'] as const;

describeWithLauncher('the ATIF trajectories for the Harbor validator (P6, N215)', () => {
  it.skipIf(OUT === undefined || OUT === '')(
    'writes the three units in both contents, and copies broken on purpose',
    { timeout: 240_000 },
    async () => {
      const out = OUT ?? '';
      const vault = new InMemorySecretVault();
      await withPlayDaemon(
        {
          codeHost: new FakeCodeHost(),
          clock: new FakeClock(),
          vault,
          client: (launcher, command, env) =>
            new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
        },
        { extra: 'atif:\n  export:\n    on: manual\n' },
        async (harness) => {
          const scenarioId = await harness.openChat();
          await harness.producer.send(scenarioId, '#ot-play write alpha and beta');
          const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
          await waitFor(
            'DONE',
            async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
          );
          const config = parseConfig('atif:\n  export:\n    on: manual\n');
          const exporter = new AtifExporter({
            store: harness.daemon.store,
            clock: harness.daemon.clock,
            vault,
            version: '0.0.0-test',
            dataDir: harness.dataDir,
            settings: () => config.atif.export,
            pricing: () => usageSettingsOf(config).pricing,
            situations: { record: () => undefined } as never,
          });

          // the valid ones: 3 units x 2 contents
          for (const unit of UNITS) {
            for (const content of CONTENTS) {
              const dir = join(out, 'valid', `${unit}-${content}`);
              await mkdir(dir, { recursive: true });
              const files = await exporter.export(play.id, { on: 'manual', unit, content, dir });
              expect(files.length).toBeGreaterThan(0);
              if (unit !== 'play') expect(files.length).toBeGreaterThan(1);
            }
          }

          // the broken ones: copies of the full trajectory of the play, each with one defect that
          // the Harbor models refuse. The defect "a dispatch with metrics" is the link of an
          // attempt to the step of the Director (llm_call_count 0), the rule of ATIF-v1.7.
          const full = JSON.parse(
            await readFile(join(out, 'valid', 'play-full', `${play.id}.atif.json`), 'utf8'),
          ) as Loose;
          const isDispatch = (step: Loose['steps'][number]): boolean =>
            step.llm_call_count === 0 && step.source === 'agent';
          const dispatchIndex = full.steps.findIndex(isDispatch);
          expect(dispatchIndex).toBeGreaterThanOrEqual(0);
          expect(full.subagent_trajectories.length).toBeGreaterThan(0);
          // every attempt is named by the dispatch step that started it, in subagent_trajectory_ref
          const referenced = full.steps
            .filter(isDispatch)
            .flatMap((step) => step.observation?.results ?? [])
            .flatMap((result) => result.subagent_trajectory_ref ?? [])
            .map((ref) => ref.trajectory_id)
            .sort();
          expect(referenced).toEqual(
            full.subagent_trajectories.map((attempt) => attempt.trajectory_id).sort(),
          );
          const defects: Record<string, (copy: Loose) => void> = {
            'unknown-field': (copy) => {
              copy.not_in_atif = 1;
            },
            'wrong-version': (copy) => {
              copy.schema_version = 'ATIF-v9.9';
            },
            'step-id-gap': (copy) => {
              const last = copy.steps[copy.steps.length - 1];
              if (last !== undefined) last.step_id += 5;
            },
            'dispatch-with-metrics': (copy) => {
              const step = copy.steps[dispatchIndex];
              if (step !== undefined) step.metrics = { prompt_tokens: 1, completion_tokens: 1 };
            },
            'attempt-without-id': (copy) => {
              const attempt = copy.subagent_trajectories[0];
              if (attempt !== undefined) delete attempt.trajectory_id;
            },
          };
          await mkdir(join(out, 'broken'), { recursive: true });
          for (const [name, defect] of Object.entries(defects)) {
            const copy = structuredClone(full);
            defect(copy);
            await writeFile(join(out, 'broken', `${name}.json`), JSON.stringify(copy, null, 2));
          }
        },
      );
    },
  );
});
