// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SYSTEM_PATHS,
  SYSTEM_SIGNALS,
  classifyTest,
  classifyTests,
  stripLineComments,
} from './cross-classify.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const cli = path.join(repo, 'tools/ci/dist/cross-classify-cli.js');
const script = path.join(repo, 'tools/ci/test-affected.sh');

let root: string;

function put(rel: string, text: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ot-cross-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('manual marks', () => {
  it('includes a pure test marked cross', () => {
    put('a/pure.test.ts', '// ot-ci: cross\nexpect(1 + 1).toBe(2);\n');
    expect(classifyTest(root, 'a/pure.test.ts')).toMatchObject({
      system: true,
      reason: 'mark: cross',
    });
  });

  it('excludes a test marked no-cross even with a signal, an e2e name or a system folder', () => {
    const text = "// ot-ci: no-cross\nimport { spawn } from 'node:child_process';\nspawn('x');\n";
    put('a/proc.test.ts', text);
    put('a/flow.e2e.test.ts', text);
    put('packages/adapters/platform-posix/src/x.test.ts', text);
    for (const file of [
      'a/proc.test.ts',
      'a/flow.e2e.test.ts',
      'packages/adapters/platform-posix/src/x.test.ts',
    ]) {
      expect(classifyTest(root, file)).toMatchObject({ system: false, reason: 'mark: no-cross' });
    }
  });

  it('includes a file with both marks (a doubt never runs less)', () => {
    put('a/both.test.ts', '// ot-ci: no-cross\n// ot-ci: cross\n');
    expect(classifyTest(root, 'a/both.test.ts').system).toBe(true);
  });

  it('reads a mark only at the start of a comment line', () => {
    put('a/text.test.ts', "const s = '// ot-ci: cross';\n");
    expect(classifyTest(root, 'a/text.test.ts').system).toBe(false);
  });
});

describe('by path', () => {
  it.each([
    'a/flow.e2e.test.ts',
    'a/flow-e2e.test.ts',
    'a/view.e2e.test.tsx',
    'a/claude.real.test.ts',
    'a/store.integration.test.ts',
    'packages/adapters/platform-windows/src/x.test.ts',
    'packages/adapters/vault-keyring/src/x.test.ts',
    'packages/fake-agent/src/x.test.ts',
    'packages/daemon/src/service/x.test.ts',
    'tools/release/src/x.test.ts',
  ])('%s is a system test with no signal in it', (file) => {
    put(file, "it('x', () => {});\n");
    const verdict = classifyTest(root, file);
    expect(verdict.system).toBe(true);
    expect(verdict.reason).toMatch(/^path: /);
  });

  it('keeps a plain test of the same package out', () => {
    put('packages/daemon/src/orchestration/plain.test.ts', "it('x', () => {});\n");
    expect(classifyTest(root, 'packages/daemon/src/orchestration/plain.test.ts').system).toBe(
      false,
    );
  });
});

describe('signals', () => {
  it('includes a test whose module under test uses child_process', () => {
    put(
      'm/run.ts',
      "import { spawn } from 'node:child_process';\nexport const run = () => spawn('x');\n",
    );
    put('m/run.test.ts', "import { run } from './run.js';\nit('x', () => run);\n");
    expect(classifyTest(root, 'm/run.test.ts')).toMatchObject({
      system: true,
      reason: 'signal child_process in m/run.ts',
    });
  });

  it('includes a test that imports a helper that spawns (one level)', () => {
    put('m/helper.ts', "import net from 'node:net';\nexport const h = net;\n");
    put('m/other.test.ts', "import { h } from './helper.js';\nit('x', () => h);\n");
    expect(classifyTest(root, 'm/other.test.ts')).toMatchObject({
      system: true,
      reason: 'signal net in m/helper.ts',
    });
  });

  it('follows an import with a folder index and a .tsx source', () => {
    put(
      'm/lib/index.ts',
      "export * from 'node:child_process';\nconst x = require('node:child_process');\n",
    );
    put('m/a.test.ts', "import { x } from './lib';\n");
    put('m/ui.tsx', "import 'node:net';\n");
    put('m/b.test.ts', "import './ui.js';\n");
    expect(classifyTest(root, 'm/a.test.ts').system).toBe(true);
    expect(classifyTest(root, 'm/b.test.ts').system).toBe(true);
  });

  it('does not follow an import two levels deep', () => {
    put('m/deep.ts', "import { spawn } from 'node:child_process';\nexport const d = spawn;\n");
    put('m/mid.ts', "import { d } from './deep.js';\nexport const mid = d;\n");
    put('m/far.test.ts', "import { mid } from './mid.js';\nit('x', () => mid);\n");
    expect(classifyTest(root, 'm/far.test.ts').system).toBe(false);
  });

  it('looks in an imported helper only for the deep signals', () => {
    put('m/paths.ts', "export const win = process.platform === 'win32';\n");
    put('m/uses.test.ts', "import { win } from './paths.js';\nit('x', () => win);\n");
    expect(classifyTest(root, 'm/uses.test.ts').system).toBe(false);
    // The same text in the module of the same name is a signal.
    put('m/paths.test.ts', "import { win } from './paths.js';\nit('x', () => win);\n");
    expect(classifyTest(root, 'm/paths.test.ts')).toMatchObject({
      system: true,
      reason: 'signal platform in m/paths.ts',
    });
  });

  it('keeps out a pure test that only uses a temp folder', () => {
    put(
      'm/pure.test.ts',
      "import { mkdtemp, writeFile } from 'node:fs/promises';\nimport path from 'node:path';\nimport { tmpdir } from 'node:os';\nit('x', async () => { await mkdtemp(path.join(tmpdir(), 'a-')); });\n",
    );
    expect(classifyTest(root, 'm/pure.test.ts')).toMatchObject({
      system: false,
      reason: 'no signal',
    });
  });

  it('ignores a signal that only a comment mentions', () => {
    put(
      'm/doc.test.ts',
      "// SIGTERM, win32 and child_process are not used here\n/* spawn(\n * SIGKILL\n */\nit('x', () => {});\n",
    );
    expect(classifyTest(root, 'm/doc.test.ts').system).toBe(false);
  });

  it('keeps out a pure function that takes the platform as a parameter', () => {
    put('m/fmt.test.ts', "it('x', () => fmt({ platform: 'win32' }));\n");
    expect(classifyTest(root, 'm/fmt.test.ts').system).toBe(false);
  });

  it('ignores an import it cannot resolve and a non-code import', () => {
    put(
      'm/x.test.ts',
      "import './missing.js';\nimport data from './data.json';\nimport { z } from 'zod';\n",
    );
    expect(classifyTest(root, 'm/x.test.ts').system).toBe(false);
  });

  it('includes a test it cannot read (a doubt never runs less)', () => {
    expect(classifyTest(root, 'm/gone.test.ts')).toMatchObject({
      system: true,
      reason: 'unreadable',
    });
  });

  it('classifies a list in order', () => {
    put('a.test.ts', "process.on('SIGTERM', () => {});\n");
    put('b.test.ts', 'it(1);\n');
    expect(classifyTests(root, ['a.test.ts', 'b.test.ts']).map((v) => v.system)).toEqual([
      true,
      false,
    ]);
  });

  // One line that each signal must catch, and a line that looks alike and must not.
  const samples: Record<string, { hit: string; miss: string }> = {
    child_process: { hit: "import cp from 'node:child_process';", miss: 'const child = 1;' },
    net: { hit: "import { createServer } from 'node:net';", miss: "import { x } from './net.js';" },
    spawn: { hit: "spawn('node', []);", miss: 'const spawned = 1;' },
    platform: { hit: "if (process.platform === 'linux') {}", miss: 'const platform = "linux";' },
    'path.sep': { hit: 'const s = path.sep;', miss: 'const sep = ",";' },
    'path semantics': {
      hit: 'const abs = path.resolve(dir, x);',
      miss: 'const joined = path.join(dir, x);',
    },
    PATHEXT: { hit: "env.PATHEXT = '.EXE';", miss: 'const EXT = 1;' },
    signal: { hit: "process.on('SIGINT', stop);", miss: 'const SIGNAL_NAME = 1;' },
    'process.kill': { hit: 'process.kill(pid, 0);', miss: 'killer.run();' },
    'chmod/mode': {
      hit: 'expect((await stat(f)).mode & 0o777).toBe(0o600);',
      miss: "const o = { mode: 'fast' };",
    },
    symlink: { hit: 'await symlink(a, b);', miss: 'const link = 1;' },
    'fs.watch': { hit: "import { watch } from 'node:fs';", miss: 'watchers.push(1);' },
    'fs error codes': { hit: "if (e.code === 'EPERM') {}", miss: 'const EPERMS = 1;' },
    'named pipe': { hit: "const p = '\\\\\\\\.\\\\pipe\\\\x';", miss: 'const pipeline = 1;' },
    'native addon': {
      hit: "import Database from 'better-sqlite3';",
      miss: "import { x } from './sqlite.js';",
    },
    homedir: { hit: 'const h = homedir();', miss: 'const homedir = home;' },
    service: { hit: "run('systemctl', ['--user']);", miss: 'const svc = new Service();' },
    'job launcher': {
      hit: "const exe = 'job-launcher.exe';",
      miss: 'const launcher = new FakeProcessLauncher();',
    },
    'system package': {
      hit: "import { x } from '@otheater/adapter-platform-posix';",
      miss: "import { x } from '@otheater/core';",
    },
  };

  it('has a sample for every signal', () => {
    expect(Object.keys(samples).sort()).toEqual(SYSTEM_SIGNALS.map((s) => s.name).sort());
  });

  it.each(Object.entries(samples))(
    '%s: catches its line and not the lookalike',
    (name, { hit, miss }) => {
      const signal = SYSTEM_SIGNALS.find((s) => s.name === name);
      expect(signal?.pattern.test(hit)).toBe(true);
      expect(signal?.pattern.test(miss)).toBe(false);
    },
  );

  it('keeps the system paths named', () => {
    expect(SYSTEM_PATHS.map((rule) => rule.name)).toContain('e2e/real/integration');
  });
});

describe('stripLineComments', () => {
  it('drops the whole-line comments and keeps code with a trailing comment', () => {
    expect(stripLineComments('// a\n  /* b\n * c\n */\nconst x = 1; // d\nspawn(y)')).toBe(
      'const x = 1; // d\nspawn(y)',
    );
  });
});

describe.skipIf(!existsSync(cli) && !process.env.CI)('cross-classify CLI', () => {
  function run(args: string[], input: string) {
    return spawnSync(process.execPath, [cli, ...args], {
      input,
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it('prints the system tests of a list read from stdin', () => {
    put('m/a.test.ts', "import { spawn } from 'node:child_process';\n");
    put('m/b.test.ts', 'it(1);\n');
    const result = run(['--root', root], 'm/a.test.ts\nm/b.test.ts\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('m/a.test.ts\n');
  });

  it('accepts backslashes in the paths (Windows)', () => {
    put('m/a.test.ts', "import 'node:net';\n");
    expect(run(['--root', root], 'm\\a.test.ts\n').stdout).toBe('m/a.test.ts\n');
  });

  it('explains every file with --explain', () => {
    put('m/a.e2e.test.ts', 'it(1);\n');
    put('m/b.test.ts', 'it(1);\n');
    const result = run(['--explain', '--root', root], 'm/a.e2e.test.ts\nm/b.test.ts\n');
    expect(result.stdout).toBe(
      'm/a.e2e.test.ts\tsystem\tpath: e2e/real/integration\nm/b.test.ts\tskip\tno signal\n',
    );
  });

  it('prints nothing for an empty list and fails (exit 2) on a bad argument', () => {
    expect(run(['--root', root], '')).toMatchObject({ status: 0, stdout: '' });
    const bad = run(['--root'], 'a.test.ts\n');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('cross-classify:');
  });
});

// The decision of the script, as OT_TEST_DRY=1 prints it. bash and pnpm exist on the runners; on
// Windows the script runs under Git Bash (`shell: bash`), which this test does not try to find.
describe.skipIf(process.platform === 'win32' || !existsSync(cli))(
  'tools/ci/test-affected.sh with OT_CROSS_TESTS',
  () => {
    function dry(env: Record<string, string>) {
      return spawnSync('bash', [script, 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, OT_TEST_CI: 'full', OT_TEST_DRY: '1', OT_CROSS_TESTS: '', ...env },
      });
    }

    it('prints only the tests that touch the system with os, and says how many', () => {
      const result = dry({ OT_CROSS_TESTS: 'os' });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /OT_CROSS_TESTS=os: (\d+) of (\d+) test file\(s\) touch the system/,
      );
      const [, selected, total] = /: (\d+) of (\d+) test/.exec(result.stdout) ?? [];
      expect(Number(selected)).toBeGreaterThan(0);
      expect(Number(selected)).toBeLessThan(Number(total));
      const files = result.stdout
        .split('\n')
        .filter((line) => line.endsWith('.test.ts') || line.endsWith('.test.tsx'));
      expect(files).toHaveLength(Number(selected));
      expect(files).toContain('tools/ci/src/cross-classify.test.ts');
    }, 120_000);

    it('changes nothing without OT_CROSS_TESTS or with all', () => {
      for (const value of ['', 'all']) {
        const result = dry({ OT_CROSS_TESTS: value });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('test-affected: full suite (OT_TEST_CI=full)');
      }
    }, 120_000);

    it('refuses another value', () => {
      const result = dry({ OT_CROSS_TESTS: 'some' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('OT_CROSS_TESTS=some: use all or os');
    }, 120_000);

    it('does not run vitest, and exits 0, when no test touches the system', () => {
      const none = path.join(root, 'none.js');
      writeFileSync(none, 'process.stdin.resume();\nprocess.stdin.on("end", () => {});\n');
      const result = dry({ OT_CROSS_TESTS: 'os', OT_CROSS_CLASSIFIER: none, OT_TEST_DRY: '' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('OT_CROSS_TESTS=os: 0 of ');
      expect(result.stdout).toContain('test-affected: no test to run');
    }, 120_000);

    it('runs the whole list, with a warning, when the classifier fails', () => {
      const result = dry({
        OT_CROSS_TESTS: 'os',
        OT_CROSS_CLASSIFIER: path.join(root, 'missing.js'),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('::warning::test-affected: the classifier failed');
      expect(result.stdout).not.toContain('touch the system');
      // The whole list is too long for one command line: it becomes `vitest run`, the whole suite.
      expect(result.stdout).toMatch(
        /test-affected: full suite \(\d{3,} test files, \d+ characters\)/,
      );
    }, 120_000);
  },
);
