// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { parseWorkflowYaml } from '@otheater/workflows';
import type { WorkflowLibrary } from '../library.js';
import { CI_FIX_YAML, GITHUB_ISSUES_YAML, PR_REVIEW_YAML } from './ready-yaml.js';

/**
 * The ready workflows (docs/24 section 11; plan of Phase 11b, P12; decision N293): `github-issues`,
 * `pr-review` and `ci-fix`. The text is the `.yaml` next to this file, embedded (`ready-yaml.ts`);
 * the daemon puts them in the library at start-up as `builtin`, so a binding can name them. They are
 * installed but not bound: nothing runs until the Producer binds one to a scenario. [proposta]
 */
export const READY_WORKFLOWS: readonly { readonly id: string; readonly yaml: string }[] = [
  { id: 'github-issues', yaml: GITHUB_ISSUES_YAML },
  { id: 'pr-review', yaml: PR_REVIEW_YAML },
  { id: 'ci-fix', yaml: CI_FIX_YAML },
];

/**
 * Installs the ready workflows in the library. The same version with the same content is idempotent
 * (`WorkflowLibrary.install`), so every start-up repeats it. It throws `InvalidInput` for a text that
 * does not parse or validate: that is a defect of the build, and the tests catch it first.
 * Returns the ids it installed.
 */
export async function installReadyWorkflows(
  library: Pick<WorkflowLibrary, 'install'>,
): Promise<string[]> {
  const installed: string[] = [];
  for (const { id, yaml } of READY_WORKFLOWS) {
    const parsed = parseWorkflowYaml(yaml);
    if (!parsed.ok) {
      throw new InvalidInput(
        `The ready workflow ${id} is not valid YAML: ${parsed.errors.map((e) => e.message).join('; ')}`,
      );
    }
    await library.install(parsed.value, { source: 'builtin' });
    installed.push(id);
  }
  return installed;
}
