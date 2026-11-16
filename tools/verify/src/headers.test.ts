// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { CopiedEntry } from './copied-code.js';
import { checkHeaders, selectHeaderFiles } from './headers.js';
import { bareRealPolicy } from './test-helpers.js';

const policy = bareRealPolicy();
const MPL = '// SPDX-License-Identifier: MPL-2.0\nexport const x = 1;\n';

function run(
  files: Record<string, string>,
  copied: CopiedEntry[] = [],
): ReturnType<typeof checkHeaders> {
  return checkHeaders(
    Object.entries(files).map(([path, content]) => ({ path, content })),
    policy,
    copied,
  );
}

const apacheHeader = (extra = ''): string =>
  `// SPDX-License-Identifier: Apache-2.0\n// Copied-From: emdash src/a.ts 1a2b3c4\n${extra}\nexport const y = 2;\n`;

const entry = (license = 'Apache-2.0'): CopiedEntry => ({
  project: 'emdash',
  license,
  sourcePath: 'src/a.ts',
  commit: '1a2b3c4',
  localFiles: ['packages/core/src/a.ts'],
  copyrightNotice: 'Copyright',
});

describe('file selection', () => {
  it('keeps source extensions and drops spikes, docs, node_modules, dist and dist-test', () => {
    const selected = selectHeaderFiles(
      [
        'a.ts',
        'b.mjs',
        'c.md',
        'd.json',
        'spikes/x.js',
        'docs/y.ts',
        'packages/core/node_modules/z.js',
        'packages/core/dist/i.js',
        'tools/verify/dist-test/t.ts',
        'packages/core/src/ok.cts',
      ],
      policy,
    );
    expect(selected).toEqual(['a.ts', 'b.mjs', 'packages/core/src/ok.cts']);
  });
});

describe('own code', () => {
  it('accepts the MPL-2.0 header, also after a shebang and in a block comment', () => {
    const result = run({
      'a.ts': MPL,
      'b.js': `#!/usr/bin/env node\n${MPL}`,
      'c.ts': '/*\n * SPDX-License-Identifier: MPL-2.0\n */\nexport {};\n',
    });
    expect(result.findings).toEqual([]);
  });

  it('rejects a missing header and one after line 5', () => {
    const late = `${'\n'.repeat(5)}// SPDX-License-Identifier: MPL-2.0\n`;
    const result = run({ 'a.ts': 'export {};\n', 'b.ts': late });
    expect(result.findings.map((f) => f.subject)).toEqual(['a.ts', 'b.ts']);
    expect(result.findings[0]?.message).toContain('SPDX-License-Identifier');
  });
});

describe('copied code', () => {
  const file = 'packages/core/src/a.ts';

  it('accepts an allowed license with Copied-From, listed in copied-code.json', () => {
    const result = run({ [file]: apacheHeader('// Modified: renamed the export') }, [entry()]);
    expect(result.findings).toEqual([]);
  });

  it('Apache-2.0 without Modified only warns', () => {
    const result = run({ [file]: apacheHeader() }, [entry()]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('warning');
  });

  it('rejects a license outside the allowed list', () => {
    const result = run({ [file]: '// SPDX-License-Identifier: GPL-3.0-only\n' }, []);
    expect(result.findings[0]?.severity).toBe('error');
    expect(result.findings[0]?.message).toContain('not on the allowed list');
  });

  it('rejects a copied file with no Copied-From line', () => {
    const result = run({ [file]: '// SPDX-License-Identifier: MIT\nexport {};\n' }, [entry('MIT')]);
    expect(result.findings.map((f) => f.message).join()).toContain('Copied-From');
  });

  it('rejects a copied file that is not in copied-code.json, or listed with another license', () => {
    const missing = run({ [file]: apacheHeader('// Modified: x') }, []);
    expect(missing.findings.map((f) => f.message).join()).toContain(
      'not listed in copied-code.json',
    );
    const other = run({ [file]: apacheHeader('// Modified: x') }, [entry('MIT')]);
    expect(other.findings.map((f) => f.message).join()).toContain('differs from copied-code.json');
  });
});
