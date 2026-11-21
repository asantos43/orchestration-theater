// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the answers of the API and the files are read as loose JSON */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { Secret } from '@otheater/core';
import { AtifTrajectorySchema, type AtifTrajectory } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { usageSettingsOf } from '../usage/index.js';
import { describeWithLauncher } from '../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayHarness,
} from '../orchestration/e2e-fixture.js';
import { dataPaths } from '../paths.js';
import { parseConfig } from '../config.js';
import { AtifExporter, type AtifExportedFile } from './atif-exporter.js';

/**
 * The ATIF export of a play of the fake agent (Phase 8, P5; architecture 5.11, N219): the Director,
 * the Actor and the Reviewer play through the daemon; the file passes the ATIF schema in both
 * contents, and a secret planted in the vault and in the Producer's request is in none of them.
 * Nothing real runs; the clock is a fake one.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const PLANTED = 'planted-secret-value-7f3a91c2';

type Get = (path: string) => Promise<{ status: number; json: any; text: string }>;

async function withPlay(
  extra: string,
  body: (harness: PlayHarness, get: Get, vault: InMemorySecretVault) => Promise<void>,
): Promise<void> {
  const vault = new InMemorySecretVault();
  await vault.set('profiles/planted/api_key', new Secret(PLANTED));
  await withPlayDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault,
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    { extra },
    async (harness) => {
      const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
      const get: Get = async (path) => {
        const response = await fetch(`${harness.daemon.api.url}${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const text = await response.text();
        return { status: response.status, json: JSON.parse(text), text };
      };
      await body(harness, get, vault);
    },
  );
}

/** Opens a chat, asks for a play that carries the planted value, and waits for it to finish. */
async function finishedPlay(harness: PlayHarness): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, `#ot-play write alpha and beta, key ${PLANTED}`);
  const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
  await waitFor(
    'DONE',
    async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
  );
  return play.id;
}

function exporterOf(harness: PlayHarness, vault: InMemorySecretVault, dir: string): AtifExporter {
  const config = parseConfig(`atif:\n  export:\n    dir: ${dir}\n`);
  return new AtifExporter({
    store: harness.daemon.store,
    clock: harness.daemon.clock,
    vault,
    version: '0.0.0-test',
    dataDir: harness.dataDir,
    settings: () => config.atif.export,
    pricing: () => usageSettingsOf(config).pricing,
    situations: { record: () => undefined } as never,
  });
}

describeWithLauncher('the ATIF export of a play (P5, N219)', { timeout: 240_000 }, () => {
  it('folds a play of the Director, the Actor and the Reviewer into a file the schema accepts, with the planted secret in no mode', async () => {
    await withPlay('atif:\n  export:\n    on: manual\n', async (harness, get, vault) => {
      const playId = await finishedPlay(harness);
      const out = await mkdtemp(join(tmpdir(), 'otheater-atif-'));
      try {
        const exporter = exporterOf(harness, vault, out);
        // the planted value is really in the play: without the mask it would reach the file
        expect((await harness.daemon.store.plays.get(playId))?.need).toContain(PLANTED);

        // the unit `play`: one file, every attempt embedded
        const [file] = (await exporter.export(playId, { on: 'manual' })) as AtifExportedFile[];
        expect(file?.path).toBe(join(out, `${playId}.atif.json`));
        const text = await readFile(file?.path ?? '', 'utf8');
        const root = JSON.parse(text) as AtifTrajectory;
        expect(AtifTrajectorySchema.safeParse(root).success).toBe(true);
        expect(root.schema_version).toBe('ATIF-v1.8');
        expect(root.agent.name).toBe('otheater-director');
        expect(root.steps.map((step) => step.step_id)).toEqual(
          root.steps.map((_, index) => index + 1),
        );
        expect(root.steps[0]?.source).toBe('user');
        expect(root.extra?.otheater?.kind).toBe('play');
        const attempts = root.subagent_trajectories ?? [];
        expect(attempts.length).toBeGreaterThan(0);
        // each attempt is dispatched by a step of the Director with no model call of its own
        const dispatches = root.steps.filter((step) => step.llm_call_count === 0);
        expect(dispatches).toHaveLength(attempts.length);
        for (const attempt of attempts) {
          expect(attempt.trajectory_id).toBeTruthy();
          expect(attempt.steps.length).toBeGreaterThan(0);
          expect(attempt.steps[0]?.source).toBe('user');
          expect(
            dispatches.some((step) =>
              step.observation?.results.some(
                (result) =>
                  result.subagent_trajectory_ref?.some(
                    (ref) => ref.trajectory_id === attempt.trajectory_id,
                  ) === true,
              ),
            ),
          ).toBe(true);
        }
        expect(text).not.toContain(PLANTED);

        // redacted: no text at all, and still no secret
        const redacted = (await exporter.export(playId, { on: 'manual', content: 'redacted' }))[0];
        const redactedText = await readFile(redacted?.path ?? '', 'utf8');
        expect(AtifTrajectorySchema.safeParse(JSON.parse(redactedText)).success).toBe(true);
        expect(redactedText).not.toContain(PLANTED);
        expect(redactedText).not.toContain('write alpha and beta');

        // the units `attempt` and `play_files`
        const perAttempt = await exporter.export(playId, { on: 'manual', unit: 'attempt' });
        expect(perAttempt).toHaveLength(attempts.length);
        const split = await exporter.export(playId, { on: 'manual', unit: 'play_files' });
        expect(split).toHaveLength(attempts.length + 1);
        for (const written of [...perAttempt, ...split]) {
          const body = await readFile(written.path, 'utf8');
          expect(AtifTrajectorySchema.safeParse(JSON.parse(body)).success).toBe(true);
          expect(body).not.toContain(PLANTED);
        }
        const rootOfSplit = JSON.parse(
          await readFile(split.find((f) => f.unit === 'play')?.path ?? '', 'utf8'),
        ) as AtifTrajectory;
        expect(rootOfSplit.subagent_trajectories).toBeUndefined();
        expect(JSON.stringify(rootOfSplit)).toContain('trajectory_path');

        // the route answers the same trajectory, and the attempt alone when asked
        const route = await get(`/v1/plays/${playId}/atif`);
        expect(route.status, route.text).toBe(200);
        expect(AtifTrajectorySchema.safeParse(route.json).success).toBe(true);
        expect(route.text).not.toContain(PLANTED);
        expect(route.json.subagent_trajectories).toHaveLength(attempts.length);
        const attemptId = attempts[0]?.trajectory_id ?? '';
        const one = await get(`/v1/plays/${playId}/atif?attemptId=${attemptId}&content=redacted`);
        expect(one.status, one.text).toBe(200);
        expect(one.json.trajectory_id).toBe(attemptId);
        expect(one.text).not.toContain(PLANTED);
        expect((await get(`/v1/plays/nope/atif`)).status).toBe(404);
        expect((await get(`/v1/plays/${playId}/atif?attemptId=nope`)).status).toBe(404);
        expect((await get(`/v1/plays/${playId}/atif?content=loose`)).status).toBe(400);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    });
  });

  it('writes the file by itself at the end of the play and says so in the log (on: play_end)', async () => {
    await withPlay('', async (harness) => {
      const playId = await finishedPlay(harness);
      const dir = join(harness.dataDir, 'trajectories');
      const name = `${playId}.atif.json`;
      await waitFor('the file', async () =>
        (await readdir(dir).catch(() => [] as string[])).includes(name),
      );
      const text = await readFile(join(dir, name), 'utf8');
      expect(AtifTrajectorySchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(text).not.toContain(PLANTED);
      const event = await waitFor('atif.exported', async () =>
        (await harness.eventsOf(playId)).find((e) => e.type === 'atif.exported'),
      );
      expect(event.payload).toMatchObject({
        unit: 'play',
        on: 'play_end',
        content: 'full',
        path: join('trajectories', name),
      });
      // the event names the file; it carries none of its content
      expect(JSON.stringify(event.payload)).not.toContain(PLANTED);
    });
  });

  it('puts the real cost in cost_usd and the API-equivalent one in extra.otheater (subscription)', async () => {
    await withPlay('atif:\n  export:\n    on: manual\n', async (harness, _get, vault) => {
      const playId = await finishedPlay(harness);
      const { store } = harness.daemon;
      const records = (await store.attempts.list()).filter((record) => record.playId === playId);
      expect(records.length).toBeGreaterThan(1);
      // The fake agent gives every attempt the same client session; a real client gives each its own.
      const [first, second] = records;
      const put = async (attempt: typeof first, sessionId: string) => {
        if (attempt === undefined) throw new Error('missing attempt');
        const input: Record<string, unknown> = { ...attempt };
        delete input.createdAt;
        delete input.updatedAt;
        return store.attempts.put({ ...input, sessionId } as Parameters<
          typeof store.attempts.put
        >[0]);
      };
      const paid = await put(first, 'session-paid');
      const subscription = await put(second, 'session-subscription');
      const sessionOf = (attemptId: string | undefined): string | undefined =>
        attemptId === paid.attemptId
          ? 'session-paid'
          : attemptId === subscription.attemptId
            ? 'session-subscription'
            : undefined;
      const record = (
        sessionId: string | undefined,
        kind: 'real' | 'api_equivalent',
        usd: number,
      ) =>
        store.usage.record({
          sessionId: sessionId ?? '',
          playId,
          profileId: 'one',
          executorId: 'fake/one/fake-model',
          model: 'fake-model',
          inputTokens: 100,
          outputTokens: 30,
          cachedTokens: 20,
          cost: { usd, kind, source: 'client' },
        });
      await record(sessionOf(paid.attemptId), 'real', 0.5);
      await record(sessionOf(subscription.attemptId), 'api_equivalent', 2);
      const out = await mkdtemp(join(tmpdir(), 'otheater-atif-'));
      try {
        const trajectory = await exporterOf(harness, vault, out).trajectory(playId);
        const byId = new Map(
          (trajectory.subagent_trajectories ?? []).map((t) => [t.trajectory_id, t]),
        );
        const real = byId.get(paid.attemptId);
        const equivalent = byId.get(subscription.attemptId);
        // an account charged by the token: cost_usd is real
        expect(real?.final_metrics?.total_cost_usd).toBe(0.5);
        expect(real?.final_metrics?.extra?.otheater?.costKind).toBe('real');
        // ATIF counts the cache inside the prompt: 100 read + 20 cached
        expect(real?.final_metrics?.total_prompt_tokens).toBe(120);
        expect(real?.final_metrics?.total_cached_tokens).toBe(20);
        expect(real?.final_metrics?.total_completion_tokens).toBe(30);
        expect(real?.steps.some((step) => step.metrics?.cost_usd === 0.5)).toBe(true);
        // a subscription: no cost_usd, the price the API would charge and the quota used go to extra
        expect(equivalent?.final_metrics?.total_cost_usd).toBeNull();
        expect(equivalent?.final_metrics?.extra?.otheater).toMatchObject({
          costKind: 'api_equivalent',
          apiEquivalentCostUsd: 2,
          quota: { inputTokens: 100, outputTokens: 30, cachedTokens: 20 },
        });
        expect(equivalent?.steps.every((step) => step.metrics?.cost_usd !== 2)).toBe(true);
        // the play sums both, and says the kinds were mixed
        expect(trajectory.final_metrics?.total_cost_usd).toBe(0.5);
        expect(trajectory.final_metrics?.extra?.otheater).toMatchObject({
          scope: 'play',
          costKind: 'mixed',
          realCostUsd: 0.5,
          apiEquivalentCostUsd: 2,
        });
        expect(AtifTrajectorySchema.safeParse(trajectory).success).toBe(true);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    });
  });

  it('fails closed with the vault locked and writes atif.export_failed (content full)', async () => {
    await withPlay('atif:\n  export:\n    on: manual\n', async (harness, _get, vault) => {
      const playId = await finishedPlay(harness);
      const out = await mkdtemp(join(tmpdir(), 'otheater-atif-'));
      const events: { type: string; payload: unknown }[] = [];
      try {
        const config = parseConfig(`atif:\n  export:\n    dir: ${out}\n`);
        const exporter = new AtifExporter({
          store: harness.daemon.store,
          clock: harness.daemon.clock,
          vault,
          version: '0.0.0-test',
          dataDir: harness.dataDir,
          settings: () => config.atif.export,
          pricing: () => usageSettingsOf(config).pricing,
          situations: {
            record: (type: string, payload: unknown) => events.push({ type, payload }),
          } as never,
        });
        vault.lock();
        await expect(exporter.export(playId, { on: 'manual' })).rejects.toMatchObject({
          reason: 'vault_unavailable',
        });
        expect(await readdir(out)).toEqual([]);
        expect(events.map((e) => e.type)).toEqual(['atif.export_failed']);
        // `redacted` writes no text, so it does not need the vault
        const files = await exporter.export(playId, { on: 'manual', content: 'redacted' });
        expect(files).toHaveLength(1);
        await expect(exporter.export('nope', { on: 'manual' })).rejects.toMatchObject({
          reason: 'play_not_found',
        });
      } finally {
        vault.unlock();
        await rm(out, { recursive: true, force: true });
      }
    });
  });
});
