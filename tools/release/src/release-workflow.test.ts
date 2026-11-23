// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './resolve.js';

/**
 * The shape of `.github/workflows/release.yml` (Phase 10, P9). The gate of R1 is two locks in a
 * workflow, and a test that reads the YAML is what keeps a later edit from opening it by accident:
 * the job `publish` exists only with both locks, no other job can write or call `gh release`, and no
 * event but a manual dispatch starts the workflow.
 */

type Json = Record<string, unknown>;
const file = path.join(repoRoot(), '.github', 'workflows', 'release.yml');
const text = readFileSync(file, 'utf8');
const workflow = parse(text) as Json;
const jobs = workflow.jobs as Record<string, Json>;

const asRecord = (value: unknown): Json =>
  typeof value === 'object' && value !== null ? (value as Json) : {};
interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Json;
}
const stepsOf = (job: Json): Step[] => (Array.isArray(job.steps) ? (job.steps as Step[]) : []);
/** What a job runs and uses, as plain text with real line breaks (not the escaped ones of JSON). */
const commandsOf = (job: Json): string =>
  stepsOf(job)
    .map((step) => `${step.uses ?? ''}\n${step.run ?? ''}`)
    .join('\n');

describe('release.yml: how it starts', () => {
  it('starts only by a manual dispatch, with the three inputs', () => {
    const on = asRecord(workflow.on);
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    const inputs = asRecord(asRecord(on.workflow_dispatch).inputs);
    expect(Object.keys(inputs).sort()).toEqual(['channel', 'publish', 'version']);
    expect(asRecord(inputs.publish)).toMatchObject({ type: 'boolean', default: false });
    expect(asRecord(inputs.channel)).toMatchObject({ type: 'choice', options: ['stable', 'beta'] });
  });

  it('has no push (tag included) and no schedule anywhere', () => {
    expect(text).not.toMatch(/^\s*push\s*:/m);
    expect(text).not.toMatch(/^\s*schedule\s*:/m);
    expect(text).not.toMatch(/^\s*pull_request(_target)?\s*:/m);
    expect(text).not.toMatch(/^\s*-?\s*cron\s*:/m);
  });
});

describe('release.yml: the gate', () => {
  it('has the job publish, and it exists only with the two locks', () => {
    expect(Object.keys(jobs)).toContain('publish');
    expect(jobs.publish?.if).toBe("inputs.publish == true && vars.OT_RELEASE_GATE == 'open'");
  });

  it('gives contents: write to the job publish and to no other', () => {
    expect(asRecord(workflow.permissions)).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(jobs)) {
      const permissions = asRecord(job.permissions);
      if (name === 'publish') {
        expect(permissions).toEqual({ contents: 'write' });
      } else {
        expect(permissions.contents, `job ${name}`).not.toBe('write');
        expect(Object.values(permissions), `job ${name}`).not.toContain('write');
      }
    }
  });

  it('calls gh release, and any release action, in the job publish only', () => {
    for (const [name, job] of Object.entries(jobs)) {
      const releases =
        /\bgh\s+release\b|action-gh-release|create-release|upload-release-asset/.test(
          commandsOf(job),
        );
      expect(releases, `job ${name}`).toBe(name === 'publish');
    }
  });

  it('reads the production secret in the job publish only', () => {
    for (const [name, job] of Object.entries(jobs)) {
      const reads = JSON.stringify(job).includes('OT_UPDATE_SIGNING_KEY');
      expect(reads, `job ${name}`).toBe(name === 'publish');
    }
    // A secret in the rehearsal is a leak waiting to happen.
    expect(text.match(/secrets\.[A-Za-z_]+/g)?.sort()).toEqual([
      'secrets.OT_UPDATE_SIGNING_KEY',
      'secrets.OT_UPDATE_SIGNING_KEY',
    ]);
  });

  it('creates the release as a draft and checks the key before it signs', () => {
    const steps = stepsOf(asRecord(jobs.publish));
    const names = steps.map((step) => step.name ?? '');
    expect(names.indexOf('Check the production key')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('Check the production key')).toBeLessThan(
      names.indexOf('Assemble, sign with the production key and check'),
    );
    const create = steps.find((step) => (step.run ?? '').includes('gh release create'));
    expect(create?.run).toContain('--draft');
    // `--draft` is not conditional: nothing else turns a release public.
    expect(text).not.toMatch(/gh release (edit|upload)/);
    expect(text).not.toMatch(/--draft=false|--latest/);
  });

  it('says in the summary why the gate is closed', () => {
    const gate = asRecord(jobs.gate);
    expect(JSON.stringify(gate)).toContain('portão do R1 fechado: ensaio, nada publicado');
    expect(JSON.stringify(gate)).toContain('GITHUB_STEP_SUMMARY');
    expect(JSON.stringify(gate)).toContain('OT_RELEASE_GATE');
    // The gate job only reports: it neither needs the build nor holds a lock.
    expect(gate.if).toBeUndefined();
  });
});

describe('release.yml: the rehearsal', () => {
  it('always runs: no job of the rehearsal depends on the gate', () => {
    for (const name of ['plan', 'gate', 'sea', 'msi', 'manifest', 'install-check']) {
      const job = asRecord(jobs[name]);
      expect(job.if, `job ${name}`).toBeUndefined();
      expect(JSON.stringify(job), `job ${name}`).not.toContain('OT_RELEASE_GATE=open');
    }
  });

  it('builds the three platforms and the msi by the workflows that already test them', () => {
    expect(asRecord(jobs.sea).uses).toBe('./.github/workflows/dist-sea.yml');
    expect(asRecord(jobs.msi).uses).toBe('./.github/workflows/dist-msi.yml');
    expect(asRecord(asRecord(jobs.sea).with).upload).toBe(true);
    expect(asRecord(asRecord(jobs.msi).with).upload).toBe(true);
  });

  it('signs the rehearsal with an ephemeral key and never with the secret', () => {
    const manifest = JSON.stringify(jobs.manifest);
    expect(manifest).toContain('ephemeral-key');
    expect(manifest).not.toContain('OT_UPDATE_SIGNING_KEY');
    expect(manifest).not.toContain('key-env');
  });

  it('keeps every artifact for one day', () => {
    const uploads: Step[] = [];
    for (const job of Object.values(jobs)) {
      for (const step of stepsOf(job)) {
        if ((step.uses ?? '').startsWith('actions/upload-artifact')) uploads.push(step);
      }
    }
    expect(uploads.length).toBeGreaterThan(0);
    for (const step of uploads) {
      expect(asRecord(step.with)['retention-days']).toBe(1);
    }
    // The called workflows keep theirs for one day too.
    for (const name of ['dist-sea.yml', 'dist-msi.yml']) {
      const called = readFileSync(path.join(repoRoot(), '.github', 'workflows', name), 'utf8');
      const rehearsal = called.slice(called.indexOf('inputs.upload == true'));
      expect(rehearsal, name).toMatch(/retention-days: 1\b/);
    }
  });

  it('runs the install tests against the files of the rehearsal', () => {
    const job = asRecord(jobs['install-check']);
    expect(JSON.stringify(job)).toContain('rehearsal-release');
    expect(JSON.stringify(job)).toContain('install.sh');
    expect(job.needs).toContain('manifest');
  });
});
