// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { parseWorkflowYaml, validateWorkflow, validateWorkflowYaml } from '@otheater/workflows';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOWS_SETTINGS } from '../config.js';
import { WorkflowLibrary } from '../library.js';
import { installReadyWorkflows, READY_WORKFLOWS } from './ready-workflows.js';
import { CI_FIX_YAML, GITHUB_ISSUES_YAML, PR_REVIEW_YAML } from './ready-yaml.js';

/** Phase 11b, P12 (N293): the three ready workflows are valid, embedded as written, and installed. */

const FILES = [
  { id: 'github-issues', file: 'github-issues.yaml', text: GITHUB_ISSUES_YAML },
  { id: 'pr-review', file: 'pr-review.yaml', text: PR_REVIEW_YAML },
  { id: 'ci-fix', file: 'ci-fix.yaml', text: CI_FIX_YAML },
] as const;

function textOf(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
}

describe.each(FILES)('the ready workflow $id', ({ id, file, text }) => {
  it('is the text the daemon embeds (ready-yaml.ts)', () => {
    expect(text).toBe(textOf(file));
  });

  it('validates with the validator of the engine, with no error and no warning', () => {
    const result = validateWorkflowYaml(text);
    expect(result.stage).toBe('definition');
    if (result.stage !== 'definition') return;
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is named by its file, at 1.0.0', () => {
    const parsed = parseWorkflowYaml(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateWorkflow(parsed.value);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.workflow.id : '').toBe(id);
    expect(result.ok ? result.workflow.version : '').toBe('1.0.0');
  });

  it('is refused when its approval is taken out (the public write needs one)', () => {
    const parsed = parseWorkflowYaml(text);
    if (!parsed.ok) throw new Error('does not parse');
    const definition = parsed.value as { nodes: Record<string, unknown>; edges: string[] };
    const nodes = { ...definition.nodes };
    delete nodes.ask;
    const edges = definition.edges
      .filter((edge) => !edge.startsWith('ask ->'))
      .map((edge) => edge.replace(/-> ask\b/, '-> done'));
    expect(validateWorkflow({ ...definition, nodes, edges }).ok).toBe(false);
  });
});

describe('the triggers the ready workflows start from', () => {
  it('github-issues: an issue that gets the label; pr-review: a pull request; ci-fix: a CI that failed', () => {
    const triggersOf = (text: string): unknown => {
      const parsed = parseWorkflowYaml(text);
      return parsed.ok ? (parsed.value as { triggers?: unknown }).triggers : undefined;
    };
    expect(triggersOf(GITHUB_ISSUES_YAML)).toEqual([
      { type: 'code_host.issue_labeled', filter: { label: 'otheater' } },
    ]);
    expect(triggersOf(PR_REVIEW_YAML)).toEqual([{ type: 'code_host.pr_opened' }]);
    expect(triggersOf(CI_FIX_YAML)).toEqual([{ type: 'code_host.ci_failed' }]);
  });
});

describe('installReadyWorkflows', () => {
  function libraryOf(): WorkflowLibrary {
    return new WorkflowLibrary({
      store: new InMemoryStore({ clock: new FakeClock() }),
      settings: () => DEFAULT_WORKFLOWS_SETTINGS,
    });
  }

  it('puts the three in the library as builtin, active, and says which', async () => {
    const library = libraryOf();
    expect(await installReadyWorkflows(library)).toEqual(['github-issues', 'pr-review', 'ci-fix']);
    for (const { id } of READY_WORKFLOWS) {
      const record = await library.active(id);
      expect(record).toMatchObject({ workflowId: id, version: '1.0.0', source: 'builtin' });
      expect(record?.state).toBe('active');
    }
  });

  it('is idempotent: every start-up repeats it with no error and no second version', async () => {
    const library = libraryOf();
    await installReadyWorkflows(library);
    await installReadyWorkflows(library);
    for (const { id } of READY_WORKFLOWS) {
      expect(await library.list({ workflowId: id })).toHaveLength(1);
    }
  });

  it('only installs: it binds nothing, so nothing runs until the Producer binds one', async () => {
    const store = new InMemoryStore({ clock: new FakeClock() });
    const library = new WorkflowLibrary({ store, settings: () => DEFAULT_WORKFLOWS_SETTINGS });
    await installReadyWorkflows(library);
    expect(await store.plays.list()).toEqual([]);
  });
});
