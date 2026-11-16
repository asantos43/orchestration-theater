// SPDX-License-Identifier: MPL-2.0
// Dependency rule (architecture 5.18, rule 3). Run with `pnpm deps` (from the repository root).
//   core    depends only on zod;
//   adapter depends on core and its own libraries, never on the daemon or on another adapter;
//   daemon  depends on core and imports adapters only at the composition point (compose.ts).
// Test files (*.test.ts) are out of the "core only zod" rule because they import the test runner.

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'core-only-zod',
      comment:
        'packages/core/src may import only files of core itself and the zod package: no Node built-ins and no other workspace package.',
      severity: 'error',
      from: { path: '^packages/core/src/', pathNot: '\\.test\\.ts$' },
      to: {
        pathNot: ['^packages/core/src/', '(^|/)node_modules/zod/', '^zod(/|$)'],
      },
    },
    {
      name: 'adapter-isolation',
      comment: 'An adapter must not import the daemon or another adapter.',
      severity: 'error',
      from: { path: '^packages/adapters/([^/]+)/src/' },
      to: {
        path: [
          '^packages/daemon/',
          '^packages/adapters/',
          '(^|/)node_modules/@otheater/(daemon|adapter-)',
        ],
        pathNot: ['^packages/adapters/$1/'],
      },
    },
    {
      name: 'daemon-adapters-only-in-compose',
      comment: 'In the daemon, only compose.ts (the composition point) may import adapters.',
      severity: 'error',
      from: { path: '^packages/daemon/src/', pathNot: '^packages/daemon/src/compose\\.ts$' },
      to: { path: ['^packages/adapters/', '(^|/)node_modules/@otheater/adapter-'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are not allowed.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Every import must resolve to a file or a package.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    exclude: { path: '(^|/)(dist|dist-test|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
