// SPDX-License-Identifier: MPL-2.0
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseViolations, runCruiser, type Violation } from './deps.js';
import { cleanupTemp, makeTemp, REPOSITORY_ROOT, writeTree } from './test-helpers.js';

afterAll(cleanupTemp);

const OK = 'export const ok = 1;\n';

let violations: Violation[] = [];

function has(rule: string, from: string): boolean {
  return violations.some((v) => v.rule === rule && v.from === from);
}

describe('dependency rule on a fixture tree', () => {
  beforeAll(async () => {
    const dir = makeTemp('otheater-deps-');
    copyFileSync(
      path.join(REPOSITORY_ROOT, 'tsconfig.base.json'),
      path.join(dir, 'tsconfig.base.json'),
    );
    copyFileSync(
      path.join(REPOSITORY_ROOT, '.dependency-cruiser.js'),
      path.join(dir, '.dependency-cruiser.js'),
    );
    writeTree(dir, {
      'node_modules/zod/package.json': '{"name":"zod","version":"0.0.0","main":"index.js"}',
      'node_modules/zod/index.js': 'exports.z = {};\n',
      // core: zod and its own files are fine; a Node built-in is not.
      'packages/core/src/good.ts':
        "import { z } from 'zod';\nimport { ok } from './helper.js';\nexport const g = [z, ok];\n",
      'packages/core/src/helper.ts': OK,
      'packages/core/src/bad.ts':
        "import { readFileSync } from 'node:fs';\nexport const b = readFileSync;\n",
      // adapters: isolated from the daemon and from each other, free to import core.
      'packages/adapters/alpha/src/index.ts':
        "import { ok } from '../../../core/src/helper.js';\nimport { b } from '../../beta/src/index.js';\nimport { d } from '../../../daemon/src/other.js';\nexport const a = [ok, b, d];\n",
      'packages/adapters/alpha/src/own.ts': OK,
      'packages/adapters/alpha/src/uses-own.ts':
        "import { ok } from './own.js';\nexport const u = ok;\n",
      'packages/adapters/beta/src/index.ts': 'export const b = 1;\n',
      // daemon: adapters only from compose.ts.
      'packages/daemon/src/compose.ts':
        "import { b } from '../../adapters/beta/src/index.js';\nexport const c = b;\n",
      'packages/daemon/src/other.ts':
        "import { b } from '../../adapters/beta/src/index.js';\nexport const d = b;\n",
      // a cycle and an unresolvable import.
      'packages/daemon/src/cycle-a.ts': "import { y } from './cycle-b.js';\nexport const x = y;\n",
      'packages/daemon/src/cycle-b.ts': "import { x } from './cycle-a.js';\nexport const y = x;\n",
      'packages/daemon/src/missing.ts':
        "import { nope } from './does-not-exist.js';\nexport const m = nope;\n",
    });
    const result = await runCruiser({
      root: REPOSITORY_ROOT,
      cwd: dir,
      config: '.dependency-cruiser.js',
      targets: ['packages'],
      outputType: 'json',
    });
    violations = parseViolations(result.stdout);
  }, 60_000);

  it('allows core to import zod and its own files', () => {
    expect(violations.some((v) => v.from === 'packages/core/src/good.ts')).toBe(false);
  });

  it('forbids core from importing a Node built-in', () => {
    expect(has('core-only-zod', 'packages/core/src/bad.ts')).toBe(true);
  });

  it('forbids an adapter from importing the daemon or another adapter, but not core or itself', () => {
    const fromAlpha = violations.filter(
      (v) => v.rule === 'adapter-isolation' && v.from === 'packages/adapters/alpha/src/index.ts',
    );
    expect(fromAlpha.map((v) => v.to).sort()).toEqual([
      'packages/adapters/beta/src/index.ts',
      'packages/daemon/src/other.ts',
    ]);
    expect(violations.some((v) => v.from === 'packages/adapters/alpha/src/uses-own.ts')).toBe(
      false,
    );
  });

  it('lets only compose.ts in the daemon import adapters', () => {
    expect(has('daemon-adapters-only-in-compose', 'packages/daemon/src/other.ts')).toBe(true);
    expect(has('daemon-adapters-only-in-compose', 'packages/daemon/src/compose.ts')).toBe(false);
  });

  it('reports cycles and unresolvable imports', () => {
    expect(violations.some((v) => v.rule === 'no-circular')).toBe(true);
    expect(has('not-to-unresolvable', 'packages/daemon/src/missing.ts')).toBe(true);
  });
});

describe('parseViolations', () => {
  it('reads the summary of the JSON output', () => {
    const json = JSON.stringify({
      summary: { violations: [{ rule: { name: 'r' }, from: 'a.ts', to: 'b.ts' }] },
    });
    expect(parseViolations(json)).toEqual([{ rule: 'r', from: 'a.ts', to: 'b.ts' }]);
  });

  it('rejects text that is not JSON or has no summary', () => {
    expect(() => parseViolations('nope')).toThrow(/JSON/);
    expect(() => parseViolations('{}')).toThrow(/summary/);
  });
});
