// SPDX-License-Identifier: MPL-2.0
// Dependency rule (architecture 5.18, rule 3). Run with `pnpm deps` (from the repository root).
//   core    depends only on zod;
//   adapter depends on core and its own libraries, never on the daemon or on another adapter;
//   daemon  depends on core and imports adapters only at the composition point (compose.ts).
// Test files (*.test.ts) are out of the "core only zod" rule because they import the test runner.
// The fakes in core/src/testing/ may be imported only by tests (rule testing-only-from-tests).

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
      name: 'registries-pure',
      comment:
        'packages/core/src/registries is pure logic (architecture 5.18): it may import itself, zod, core/src/errors.ts and the event envelope of core/src/ports/event-log.ts. No adapter, no daemon, no protocol, no other port.',
      severity: 'error',
      from: { path: '^packages/core/src/registries/', pathNot: '\\.test\\.ts$' },
      to: {
        pathNot: [
          '^packages/core/src/registries/',
          '^packages/core/src/errors\\.ts$',
          '^packages/core/src/ports/event-log\\.ts$',
          '(^|/)node_modules/zod/',
          '^zod(/|$)',
        ],
      },
    },
    {
      name: 'protocol-only-core-and-zod',
      comment:
        'packages/protocol/src is the wire contract: it may import only itself, @otheater/core (types and errors) and zod. No adapter, no daemon, no Node built-ins [proposta].',
      severity: 'error',
      from: { path: '^packages/protocol/src/', pathNot: '\\.test\\.ts$' },
      to: {
        pathNot: [
          '^packages/protocol/src/',
          '^packages/core/(src|dist)/(?!testing/)',
          '(^|/)node_modules/@otheater/core/(src|dist)/(?!testing/)',
          '(^|/)node_modules/zod/',
          '^zod(/|$)',
        ],
      },
    },
    {
      name: 'testing-only-from-tests',
      comment:
        'The fakes of @otheater/core/testing are for tests: outside testing/ itself, only *.test.ts files may import them (decision N50).',
      severity: 'error',
      from: { pathNot: ['^packages/core/src/testing/', '\\.test\\.ts$'] },
      to: {
        path: [
          '^packages/core/(src|dist)/testing/',
          '(^|/)node_modules/@otheater/core/(src|dist)/testing/',
        ],
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
      comment:
        'In the daemon, only compose.ts (the composition point) and prompts.ts (the prompt source, outside compose.ts to keep P11 apart from it) may import adapters.',
      severity: 'error',
      from: {
        path: '^packages/daemon/src/',
        pathNot: '^packages/daemon/src/(compose|prompts)\\.ts$',
      },
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
    // Imports by package name (`@otheater/core`, `vitest`) resolve to build output under `dist/`.
    // Excluding `dist/` would drop those edges from the graph and hide them from every rule, so
    // build output is kept as leaves (not followed) and only `coverage/` is excluded.
    doNotFollow: { path: '(^|/)node_modules/|/dist(-test)?/' },
    exclude: { path: '(^|/)coverage/' },
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
