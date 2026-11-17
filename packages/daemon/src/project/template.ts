// SPDX-License-Identifier: MPL-2.0

/**
 * The initial structure of a project the OTheater creates with the `software` profile
 * (architecture 5.20). [proposta] The template is code, not a download: it ships inside `dist`, so
 * a new project needs no network and no other repository. A change to what it writes is a new
 * {@link SOFTWARE_TEMPLATE_VERSION}.
 */
export const SOFTWARE_TEMPLATE_VERSION = 1;

export interface TemplateFile {
  /** Path inside the repository, with `/`. */
  readonly path: string;
  readonly content: string;
  /** The file is a script: the executable bit is set (and git keeps it). */
  readonly executable?: boolean;
}

export interface TemplateInput {
  /** Name of the project, for the README. */
  readonly name: string;
  /** The main branch: the CI runs on pushes to it and on pull requests. */
  readonly mainBranch: string;
}

/** Where the profile keeps the command of the tests: CI and `run_tests` run the same file. */
export const TEST_SCRIPT = 'scripts/test.sh';

function readme(input: TemplateInput): string {
  return [
    `# ${input.name}`,
    '',
    'Project created by the OTheater with the `software` profile.',
    '',
    '## Tests',
    '',
    `Run \`./${TEST_SCRIPT}\`. It is the one command the CI and the OTheater run, so the project has`,
    'one place that says what "the tests pass" means: replace the body of the script with the real',
    'test command of the project.',
    '',
    '## Changes',
    '',
    'Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) and the',
    'changes are listed in [CHANGELOG.md](CHANGELOG.md), in the',
    '[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Every delivery of the',
    'OTheater adds its entry under `[Unreleased]`.',
    '',
  ].join('\n');
}

const GITIGNORE = [
  '# Dependencies and build output',
  'node_modules/',
  'dist/',
  'build/',
  'target/',
  '__pycache__/',
  '*.pyc',
  '',
  '# Local files',
  '.env',
  '.env.*',
  '!.env.example',
  '*.log',
  '.DS_Store',
  '',
].join('\n');

/** Empty `[Unreleased]`: the first delivery adds the subsection of its type under it. */
const CHANGELOG = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file.',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
  '',
  '## [Unreleased]',
  '',
].join('\n');

const TEST_SCRIPT_TEXT = [
  '#!/usr/bin/env sh',
  '# The command that says whether the project is fine: the CI and the OTheater run this file.',
  '# Replace the body with the real test command (`npm test`, `cargo test`, `pytest`, ...).',
  'set -eu',
  '',
  'echo "No tests yet: replace scripts/test.sh with the test command of the project."',
  '',
].join('\n');

function workflow(input: TemplateInput): string {
  return [
    'name: CI',
    '',
    'on:',
    '  push:',
    `    branches: [${JSON.stringify(input.mainBranch)}]`,
    '  pull_request:',
    '',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: Test',
    `        run: ./${TEST_SCRIPT}`,
    '',
  ].join('\n');
}

/** The files of a new project of the `software` profile. */
export function softwareTemplate(input: TemplateInput): readonly TemplateFile[] {
  return [
    { path: 'README.md', content: readme(input) },
    { path: '.gitignore', content: GITIGNORE },
    { path: 'CHANGELOG.md', content: CHANGELOG },
    { path: TEST_SCRIPT, content: TEST_SCRIPT_TEXT, executable: true },
    { path: '.github/workflows/ci.yml', content: workflow(input) },
  ];
}
