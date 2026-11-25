// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  configureTemporaryCleanup,
  onTemporarySweepFailure,
  type TemporaryShape,
} from '@otheater/client/node';
import { LAYOUT_VERSION, type LayoutPreferences } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePrivateFile } from './api/files.js';
import { writeExportFile } from './atif/atif-exporter.js';
import { editConfigFile } from './config-edit.js';
import { InstanceLock } from './instance-lock.js';
import { LayoutPreferencesStore } from './layout/preferences.js';
import { shimFileOf, shimNameOf, syncShims } from './profiles/shims.js';
import { RecordingSituations, captureLogger } from './test-helpers.js';
import { sweepDaemonFileTemporaries } from './temporaries.js';
import { writeJournal, type UpdateJournal } from './updates/apply/journal.js';

/**
 * Every place of the daemon that writes a file as "a temporary beside it, then a rename" (N306, the
 * continuation of #347): after the write the orphans of that file are gone, by the rules of the
 * `temporaries` policy, and only the ones of the exact name of that file.
 */

const HEX = '0123456789abcdef0123456789abcdef';
const JOURNAL: UpdateJournal = {
  v: 1,
  from: '0.5.0',
  to: '0.6.0',
  sha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  step: 'waiting',
  oldPid: 0,
  applierPid: 0,
  dataDir: '/data',
  exe: '/x/ot',
  rollback: 'auto',
  healthTimeoutMs: 1000,
  stableMs: 0,
  backup: null,
  reason: null,
  reported: false,
  startedAt: 1,
  updatedAt: 1,
};
const LAYOUT: LayoutPreferences = {
  version: LAYOUT_VERSION,
  sidebarCollapsed: true,
  chatWidth: 72,
  openTabs: ['overview'],
  collapsedSections: [],
};

interface Site {
  readonly point: string;
  /** The file this site writes, inside `dir`. */
  readonly target: (dir: string) => string;
  readonly shape: TemporaryShape;
  /** Writes the file once. */
  readonly write: (dir: string, target: string) => Promise<void>;
  readonly skip?: boolean;
  /** `false` when the site removes the file itself at the end (the lock). */
  readonly keepsTarget?: boolean;
}

const POSIX = process.platform !== 'win32';
const SHIM = shimFileOf(shimNameOf('', 'codex', 'personal'), 'posix');

const SITES: readonly Site[] = [
  {
    point: 'writePrivateFile (the API files, the layout, the ATIF command, the token rotation)',
    target: (dir) => join(dir, 'secret'),
    shape: { hexLength: 16 },
    write: (_dir, target) => writePrivateFile(target, 'one'),
  },
  {
    point: 'the ATIF export',
    target: (dir) => join(dir, 'exports', 'play.atif.json'),
    shape: { hexLength: 0 },
    write: (_dir, target) => writeExportFile(dirname(target), target, 'one'),
  },
  {
    point: 'the edit of config.yaml',
    target: (dir) => join(dir, 'config.yaml'),
    shape: { hexLength: 8 },
    write: async (_dir, target) => {
      await editConfigFile(target, (editor) => {
        editor.set(['executors', 'on_register'], 'none');
      });
    },
  },
  {
    point: 'the info file of the instance lock',
    target: (dir) => join(dir, 'daemon.lock.json'),
    shape: { hexLength: 0 },
    keepsTarget: false,
    write: async (dir, target) => {
      const lock = await InstanceLock.acquire(join(dir, 'daemon.lock'), target);
      try {
        await lock.publish({ pid: process.pid, startedAt: 1, version: '0.0.0' });
      } finally {
        await lock.release();
      }
    },
  },
  {
    point: 'the journal of an update',
    target: (dir) => join(dir, 'update-state.json'),
    shape: { hexLength: 0 },
    write: (_dir, target) => writeJournal(target, JOURNAL),
  },
  {
    point: 'the layout preferences',
    target: (dir) => join(dir, 'layout', 'tui.json'),
    shape: { hexLength: 16 },
    write: async (_dir, target) => {
      const store = await LayoutPreferencesStore.open({
        dir: dirname(target),
        situations: new RecordingSituations(),
        logger: captureLogger().logger,
      });
      await store.put('tui', LAYOUT);
    },
  },
  {
    point: 'a profile shim',
    target: (dir) => join(dir, 'bin', SHIM),
    shape: { hexLength: 0, hidden: true },
    skip: !POSIX,
    write: async (dir, target) => {
      await syncShims({
        binDir: dirname(target),
        dataDir: dir,
        prefix: '',
        launcher: { node: '/opt/node/bin/node', entry: '/opt/ot/cli.js' },
        platform: 'posix',
        env: { PATH: '/nowhere' },
        profiles: [{ id: 'codex/personal', client: 'codex', name: 'personal' }],
      });
    },
  },
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ot-temporary-sites-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function nameOf(target: string, shape: TemporaryShape, pid: number): string {
  const hex = shape.hexLength > 0 ? `.${HEX.slice(0, shape.hexLength)}` : '';
  return `${shape.hidden === true ? '.' : ''}${basename(target)}.${String(pid)}${hex}.tmp`;
}

/** The pid of a process that has already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
}

async function listing(folder: string): Promise<string[]> {
  return (await readdir(folder)).sort();
}

describe.each(SITES.filter((site) => site.skip !== true))('orphan temporaries: $point', (site) => {
  async function ready(): Promise<{ target: string; folder: string }> {
    const target = site.target(dir);
    const folder = dirname(target);
    await mkdir(folder, { recursive: true });
    return { target, folder };
  }

  it('removes the temporary of a dead pid, keeps the one of a live pid and the ones outside the pattern', async () => {
    const { target, folder } = await ready();
    const gone = deadPid();
    const orphan = nameOf(target, site.shape, gone);
    const live = nameOf(target, site.shape, process.ppid);
    const outside = [
      `${basename(target)}.${String(gone)}.bak`,
      `${basename(target)}.${String(gone)}.${HEX.slice(0, 7)}.tmp`,
      `other-${basename(target)}.${String(gone)}.tmp`,
    ].filter((name) => name !== orphan);
    for (const name of [orphan, live, ...outside]) await writeFile(join(folder, name), 'x');
    await site.write(dir, target);
    const after = await listing(folder);
    expect(after).not.toContain(orphan);
    expect(after).toContain(live);
    for (const name of outside) expect(after).toContain(name);
    if (site.keepsTarget !== false) expect(after).toContain(basename(target));
  });

  it('in age mode removes the old temporary and keeps the new one, whatever the pid says', async () => {
    const { target, folder } = await ready();
    const old = nameOf(target, site.shape, process.ppid);
    const fresh = nameOf(target, site.shape, deadPid());
    await writeFile(join(folder, old), 'old');
    await writeFile(join(folder, fresh), 'new');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(join(folder, old), twoHoursAgo, twoHoursAgo);
    const stop = configureTemporaryCleanup({ mode: 'age', maxAgeMs: 60 * 60_000 });
    try {
      await site.write(dir, target);
    } finally {
      stop();
    }
    const after = await listing(folder);
    expect(after).not.toContain(old);
    expect(after).toContain(fresh);
  });

  it('with the cleaning off keeps the orphan', async () => {
    const { target, folder } = await ready();
    const orphan = nameOf(target, site.shape, deadPid());
    await writeFile(join(folder, orphan), 'half');
    const stop = configureTemporaryCleanup({ mode: 'off' });
    try {
      await site.write(dir, target);
    } finally {
      stop();
    }
    expect(await listing(folder)).toContain(orphan);
  });

  it('a temporary it cannot remove is told to the sink and the write still succeeds', async () => {
    const { target, folder } = await ready();
    // A folder with the name of a temporary: the removal of a file refuses it.
    const stuck = nameOf(target, site.shape, deadPid());
    await mkdir(join(folder, stuck));
    const failures: string[] = [];
    const stop = onTemporarySweepFailure((failure) => failures.push(failure.name));
    try {
      await site.write(dir, target);
    } finally {
      stop();
    }
    // A site may sweep more than once (the layout does it when it opens and when it writes).
    expect(new Set(failures)).toEqual(new Set([stuck]));
    if (site.keepsTarget !== false) expect(await listing(folder)).toContain(basename(target));
  });
});

describe('the start-up cleaning of config.yaml and plugins.json', () => {
  it('removes the orphans of both, also one with its own pid, and nothing else', async () => {
    const gone = deadPid();
    const names = [
      `config.yaml.${String(gone)}.${HEX.slice(0, 8)}.tmp`,
      `config.yaml.${String(process.pid)}.${HEX.slice(0, 8)}.tmp`,
      `plugins.json.${String(gone)}.${HEX.slice(0, 8)}.tmp`,
    ];
    const keep = [
      `config.yaml.${String(process.ppid)}.${HEX.slice(0, 8)}.tmp`,
      `config.yaml.${String(gone)}.tmp`,
      `plugins.json.lock`,
      'config.yaml',
    ];
    for (const name of [...names, ...keep]) await writeFile(join(dir, name), 'x');
    const removed = await sweepDaemonFileTemporaries({
      configPath: join(dir, 'config.yaml'),
      dataDir: dir,
    });
    expect(removed.sort()).toEqual([...names].sort());
    expect(await listing(dir)).toEqual([...keep].sort());
  });

  it('a temporary it cannot remove goes to the sink and the start goes on', async () => {
    const stuck = `config.yaml.${String(deadPid())}.${HEX.slice(0, 8)}.tmp`;
    await mkdir(join(dir, stuck));
    const failures: string[] = [];
    const stop = onTemporarySweepFailure((failure) => failures.push(failure.name));
    try {
      await expect(
        sweepDaemonFileTemporaries({ configPath: join(dir, 'config.yaml'), dataDir: dir }),
      ).resolves.toEqual([]);
    } finally {
      stop();
    }
    expect(failures).toEqual([stuck]);
  });
});
