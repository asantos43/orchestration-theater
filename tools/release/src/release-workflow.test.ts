// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { MACOS_SIGNING_MODES, WINDOWS_SIGNING_MODES } from './config.js';
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
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
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
    // A secret in the rehearsal is a leak waiting to happen: the update key twice (the two steps of
    // publish) and the code signing secrets of P11, which have their own test below.
    const production = text.match(/secrets\.OT_UPDATE_SIGNING_KEY/g);
    expect(production).toHaveLength(2);
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
    for (const name of [
      'plan',
      'gate',
      'signing',
      'sea',
      'msi',
      'sign-windows',
      'sign-macos',
      'manifest',
      'install-check',
    ]) {
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

  it('signs both ways and pins the manifest, and no verifier is a requirement of the runner', () => {
    const manifest = JSON.stringify(jobs.manifest);
    // `sign` writes the .sig and the .sshsig; `embed-key --manifest` pins the SHA-256 (N288).
    expect(manifest).toContain('manifest.json.sshsig');
    expect(manifest).toMatch(/embed-key[^"]*--manifest release\/manifest\.json/);
    const publish = JSON.stringify(jobs.publish);
    expect(publish).toMatch(/embed-key[^"]*--manifest release\/manifest\.json/);
    const check = JSON.stringify(jobs['install-check']);
    // The three verifiers are run on their own, and none of them needs Homebrew's openssl@3.
    expect(check).toContain('OT_INSTALL_VERIFIER');
    expect(check).toContain('ssh-keygen');
    expect(check).toContain('pinned');
    expect(check).not.toContain('brew');
    expect(check).not.toContain('OT_INSTALL_OPENSSL');
    expect(check).not.toContain('is not approved');
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

/**
 * Code signing (Phase 10, P11, N247). Both keys are off in the repository, so the signing steps must
 * not run; with a key on and a secret missing, a check in the job `signing` fails before anything is
 * built or published; and the secrets of the certificates are read by the signing jobs and by no other.
 */
const WINDOWS_SECRETS = ['OT_WINDOWS_SIGNING_CERT_BASE64', 'OT_WINDOWS_SIGNING_CERT_PASSWORD'];
const MACOS_SECRETS = [
  'OT_MACOS_SIGNING_CERT_BASE64',
  'OT_MACOS_SIGNING_CERT_PASSWORD',
  'OT_MACOS_SIGNING_IDENTITY',
  'OT_MACOS_NOTARY_APPLE_ID',
  'OT_MACOS_NOTARY_PASSWORD',
  'OT_MACOS_NOTARY_TEAM_ID',
];

const needsOf = (name: string): string[] => {
  const needs = asRecord(jobs[name]).needs;
  return Array.isArray(needs) ? (needs as string[]) : [];
};
/** Every job a job waits for, directly or not. */
const closureOf = (name: string, seen = new Set<string>()): Set<string> => {
  for (const need of needsOf(name)) {
    if (!seen.has(need)) {
      seen.add(need);
      closureOf(need, seen);
    }
  }
  return seen;
};
const secretsOf = (job: Json): string[] =>
  [...new Set(JSON.stringify(job).match(/secrets\.[A-Za-z0-9_]+/g) ?? [])]
    .map((secret) => secret.slice('secrets.'.length))
    .sort();

/**
 * Evaluates the tiny `if:` expressions of the signing steps (`==` and `!=` over the outputs of the
 * modes, joined by `||` and `&&`) so the test can say which steps run for a pair of modes. Anything
 * else is refused, so a more complex `if` makes the test say so instead of passing by accident.
 */
function runs(condition: string | undefined, modes: { windows: string; macos: string }): boolean {
  if (condition === undefined) return true;
  const comparison = (text: string): boolean => {
    const match =
      /^(?:steps\.modes|needs\.signing)\.outputs\.(windows|macos)\s*(==|!=)\s*'(\w+)'$/.exec(
        text.trim(),
      );
    if (match === null) throw new Error(`not a simple if: ${condition}`);
    const value = modes[match[1] as 'windows' | 'macos'];
    return match[2] === '==' ? value === match[3] : value !== match[3];
  };
  return condition
    .split('||')
    .some((either) => either.split('&&').every((both) => comparison(both)));
}
const label = (step: Step): string => step.name ?? step.uses ?? '(step)';

describe('release.yml: code signing keys (P11)', () => {
  it('has the job signing before the build, with no if, and the modes as outputs', () => {
    const signing = asRecord(jobs.signing);
    // A job that needs a skipped job is skipped, and the manifest would go with it.
    expect(signing.if).toBeUndefined();
    expect(signing.needs).toBeUndefined();
    expect(Object.keys(asRecord(signing.outputs)).sort()).toEqual(['macos', 'windows']);
    // The secrets are checked before anything is built or published.
    for (const name of ['sea', 'msi', 'sign-windows', 'sign-macos', 'manifest', 'publish']) {
      expect(closureOf(name).has('signing'), `job ${name}`).toBe(true);
    }
    expect(needsOf('sea')).toContain('signing');
    expect(needsOf('msi')).toContain('signing');
  });

  it('puts the signing jobs between the build and the manifest, and in front of publish', () => {
    for (const name of ['manifest', 'publish']) {
      for (const job of ['sign-windows', 'sign-macos']) {
        expect(needsOf(name), `job ${name}`).toContain(job);
      }
    }
    expect(needsOf('sign-windows')).toEqual(expect.arrayContaining(['signing', 'sea', 'msi']));
    expect(needsOf('sign-macos')).toEqual(expect.arrayContaining(['signing', 'sea']));
    // The install tests run after the manifest, so they test the signed files.
    expect(closureOf('install-check').has('sign-windows')).toBe(true);
    expect(closureOf('install-check').has('sign-macos')).toBe(true);
  });

  it('accepts the same modes the config file does', () => {
    const modes = stepsOf(asRecord(jobs.signing)).find((step) => step.id === 'modes');
    expect(modes?.run).toContain(`${WINDOWS_SIGNING_MODES.join(' | ')})`);
    expect(modes?.run).toContain(`${MACOS_SIGNING_MODES.join(' | ')})`);
    // The repository variable overrides the file, and the file is the one of the build keys.
    expect(modes?.env).toEqual({
      VAR_WINDOWS: '${{ vars.OT_SIGNING_WINDOWS }}',
      VAR_MACOS: '${{ vars.OT_SIGNING_MACOS }}',
    });
    expect(modes?.run).toContain('tools/release/release.config.json');
  });

  it('runs no signing step with both keys off, and each platform on its own key', () => {
    const everyStep = [
      ...stepsOf(asRecord(jobs.signing)).slice(2), // after checkout and the modes
      ...stepsOf(asRecord(jobs['sign-windows'])),
      ...stepsOf(asRecord(jobs['sign-macos'])),
    ];
    const off = { windows: 'off', macos: 'off' };
    for (const step of everyStep) {
      expect(step.if, label(step)).toBeDefined();
      expect(runs(step.if, off), label(step)).toBe(false);
    }
    const windowsOnly = { windows: 'signtool', macos: 'off' };
    for (const step of stepsOf(asRecord(jobs['sign-windows']))) {
      expect(runs(step.if, windowsOnly), label(step)).toBe(true);
    }
    for (const step of stepsOf(asRecord(jobs['sign-macos']))) {
      expect(runs(step.if, windowsOnly), label(step)).toBe(false);
    }
    const macosOnly = { windows: 'off', macos: 'codesign' };
    for (const step of stepsOf(asRecord(jobs['sign-macos']))) {
      expect(runs(step.if, macosOnly), label(step)).toBe(true);
    }
    for (const step of stepsOf(asRecord(jobs['sign-windows']))) {
      expect(runs(step.if, macosOnly), label(step)).toBe(false);
    }
  });

  it('signs the files before the manifest hashes them, under the same artifact names', () => {
    const windowsUploads = stepsOf(asRecord(jobs['sign-windows'])).filter((step) =>
      (step.uses ?? '').startsWith('actions/upload-artifact'),
    );
    expect(windowsUploads.map((step) => asRecord(step.with).name)).toEqual([
      'sea-win32-x64',
      'msi-win32-x64',
    ]);
    const macosUploads = stepsOf(asRecord(jobs['sign-macos'])).filter((step) =>
      (step.uses ?? '').startsWith('actions/upload-artifact'),
    );
    expect(macosUploads.map((step) => asRecord(step.with).name)).toEqual(['sea-darwin-arm64']);
    for (const step of [...windowsUploads, ...macosUploads]) {
      expect(asRecord(step.with).overwrite).toBe(true);
      expect(asRecord(step.with)['retention-days']).toBe(1);
    }
    // signtool signs and verifies; codesign signs, verifies and notarizes.
    expect(commandsOf(asRecord(jobs['sign-windows']))).toMatch(/signtool|\$signtool/);
    expect(commandsOf(asRecord(jobs['sign-windows']))).toContain('verify /pa');
    const macos = commandsOf(asRecord(jobs['sign-macos']));
    expect(macos).toContain('codesign --force --options runtime --timestamp');
    expect(macos).toContain('notarytool submit');
    expect(macos).toContain('Accepted');
  });

  it('reads the signing secrets in the three signing jobs only, and never prints them', () => {
    const expected: Record<string, string[]> = {
      signing: [...WINDOWS_SECRETS, ...MACOS_SECRETS].sort(),
      'sign-windows': [...WINDOWS_SECRETS].sort(),
      'sign-macos': [...MACOS_SECRETS].sort(),
      publish: ['OT_UPDATE_SIGNING_KEY'],
    };
    for (const [name, job] of Object.entries(jobs)) {
      expect(secretsOf(job), `job ${name}`).toEqual(expected[name] ?? []);
    }
    // No `echo` or `printf` of a secret by name: the check only tests it for emptiness.
    const all = [...WINDOWS_SECRETS, ...MACOS_SECRETS];
    for (const name of ['signing', 'sign-windows', 'sign-macos']) {
      for (const step of stepsOf(asRecord(jobs[name]))) {
        for (const line of (step.run ?? '').split('\n')) {
          if (!/\b(echo|printf|Write-Host|Write-Output)\b/.test(line)) continue;
          for (const secret of all) {
            // `printf '%s' "$SECRET" | base64 --decode` feeds a pipe: the only allowed use.
            if (line.includes(`"$${secret}"`)) expect(line, `job ${name}`).toContain('| base64');
            expect(line, `job ${name}`).not.toContain(`$env:${secret}"`);
          }
        }
      }
    }
  });

  it('does not touch the update key, the manifest or gh release in the signing jobs', () => {
    for (const name of ['signing', 'sign-windows', 'sign-macos']) {
      const job = JSON.stringify(jobs[name]);
      expect(job, `job ${name}`).not.toContain('OT_UPDATE_SIGNING_KEY');
      expect(job, `job ${name}`).not.toContain('manifest.json');
      expect(asRecord(asRecord(jobs[name]).permissions).contents ?? 'read').not.toBe('write');
    }
  });

  it('ships entitlements for the hardened runtime of the macOS executable', () => {
    const plist = readFileSync(
      path.join(repoRoot(), 'tools', 'release', 'macos-entitlements.plist'),
      'utf8',
    );
    expect(plist).toContain('com.apple.security.cs.allow-jit');
    expect(commandsOf(asRecord(jobs['sign-macos']))).toContain(
      'tools/release/macos-entitlements.plist',
    );
  });
});

/**
 * The shell of the steps `modes` and the two secret checks, run for real with bash in a folder that
 * has only a config file. They need nothing else than bash and node.
 */
describe.skipIf(process.platform === 'win32')('release.yml: the signing checks, executed', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const signingStep = (match: (step: Step) => boolean): Step => {
    const step = stepsOf(asRecord(jobs.signing)).find(match);
    if (step?.run === undefined) throw new Error('step of the job signing not found');
    return step;
  };
  const modesStep = (): Step => signingStep((step) => step.id === 'modes');
  const checkStep = (platform: 'Windows' | 'macOS'): Step =>
    signingStep((step) => step.name === `Check the ${platform} signing secrets`);

  function sandbox(config: unknown): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'otheater-signing-'));
    dirs.push(dir);
    mkdirSync(path.join(dir, 'tools', 'release'), { recursive: true });
    writeFileSync(
      path.join(dir, 'tools', 'release', 'release.config.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
    );
    return dir;
  }

  function run(step: Step, dir: string, env: Record<string, string> = {}) {
    const output = path.join(dir, 'github-output');
    const summary = path.join(dir, 'github-summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['-c', step.run ?? ''], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return {
      status: result.status,
      outputs,
      log: `${result.stdout}${result.stderr}`,
      summary: readFileSync(summary, 'utf8'),
    };
  }

  const none = { VAR_WINDOWS: '', VAR_MACOS: '' };

  it('reads off, off from the config of the repository', () => {
    const real = readFileSync(
      path.join(repoRoot(), 'tools', 'release', 'release.config.json'),
      'utf8',
    );
    const result = run(modesStep(), sandbox(real), none);
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual({ windows: 'off', macos: 'off' });
    expect(result.summary).toContain('Desligada nas duas plataformas');
  });

  it('takes off when the config has no signing key at all', () => {
    const result = run(modesStep(), sandbox({ targets: ['linux-x64'] }), none);
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual({ windows: 'off', macos: 'off' });
  });

  it('reads the modes of the file, and the repository variable wins over it', () => {
    const dir = sandbox({ signing: { windows: 'signtool', macos: 'off' } });
    expect(run(modesStep(), dir, none).outputs).toEqual({ windows: 'signtool', macos: 'off' });
    const overridden = run(modesStep(), dir, { VAR_WINDOWS: 'off', VAR_MACOS: 'codesign' });
    expect(overridden.outputs).toEqual({ windows: 'off', macos: 'codesign' });
  });

  it('refuses a mode that does not exist, and a config that is not JSON', () => {
    const dir = sandbox({});
    const wrongForWindows = run(modesStep(), dir, { ...none, VAR_WINDOWS: 'codesign' });
    expect(wrongForWindows.status).toBe(1);
    expect(wrongForWindows.log).toContain('signing.windows');
    const wrongForMacos = run(modesStep(), dir, { ...none, VAR_MACOS: 'signtool' });
    expect(wrongForMacos.status).toBe(1);
    expect(wrongForMacos.log).toContain('signing.macos');
    expect(run(modesStep(), sandbox('{ not json'), none).status).not.toBe(0);
  });

  it('fails the Windows check, naming the secrets, when none or one is set', () => {
    const dir = sandbox({});
    const empty = run(checkStep('Windows'), dir, {
      OT_WINDOWS_SIGNING_CERT_BASE64: '',
      OT_WINDOWS_SIGNING_CERT_PASSWORD: '',
    });
    expect(empty.status).toBe(1);
    expect(empty.log).toContain('::error::signing.windows is signtool');
    for (const name of WINDOWS_SECRETS) expect(empty.log).toContain(name);
    expect(empty.log).toContain('Nothing was built or published');

    const partial = run(checkStep('Windows'), dir, {
      OT_WINDOWS_SIGNING_CERT_BASE64: 'x',
      OT_WINDOWS_SIGNING_CERT_PASSWORD: '',
    });
    expect(partial.status).toBe(1);
    expect(partial.log).toContain('OT_WINDOWS_SIGNING_CERT_PASSWORD');
    expect(partial.log).not.toContain('OT_WINDOWS_SIGNING_CERT_BASE64');
  });

  it('passes the Windows check with both secrets, without printing them', () => {
    const result = run(checkStep('Windows'), sandbox({}), {
      OT_WINDOWS_SIGNING_CERT_BASE64: 'not-a-real-value-1',
      OT_WINDOWS_SIGNING_CERT_PASSWORD: 'not-a-real-value-2',
    });
    expect(result.status).toBe(0);
    expect(result.log).not.toContain('not-a-real-value');
  });

  it('fails the macOS check for each secret that is missing, and passes with all six', () => {
    const dir = sandbox({});
    const all = Object.fromEntries(MACOS_SECRETS.map((name) => [name, 'not-a-real-value']));
    expect(run(checkStep('macOS'), dir, all).status).toBe(0);
    for (const missing of MACOS_SECRETS) {
      const result = run(checkStep('macOS'), dir, { ...all, [missing]: '' });
      expect(result.status, missing).toBe(1);
      expect(result.log, missing).toContain(missing);
      expect(result.log).toContain('::error::signing.macos is codesign');
    }
    const none6 = run(checkStep('macOS'), dir, {});
    expect(none6.status).toBe(1);
    for (const name of MACOS_SECRETS) expect(none6.log).toContain(name);
  });

  it('refuses to sign from a branch other than main', () => {
    const guard = signingStep((step) => step.name === 'Signing only from main');
    const dir = sandbox({});
    expect(runs(guard.if, { windows: 'off', macos: 'off' })).toBe(false);
    expect(runs(guard.if, { windows: 'signtool', macos: 'off' })).toBe(true);
    expect(runs(guard.if, { windows: 'off', macos: 'codesign' })).toBe(true);
    const branch = run(guard, dir, { GITHUB_REF: 'refs/heads/fase10/p11-assinatura' });
    expect(branch.status).toBe(1);
    expect(branch.log).toContain('refs/heads/main');
    expect(run(guard, dir, { GITHUB_REF: 'refs/heads/main' }).status).toBe(0);
  });
});
