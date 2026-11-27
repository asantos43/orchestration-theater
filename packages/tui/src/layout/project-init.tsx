// SPDX-License-Identifier: MPL-2.0
import type { FolderInitChoice, InspectFolderResult } from '@otheater/protocol';
import { Box } from 'ink';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from './themed-text.js';
import { clipStart } from './text.js';
import { TOKEN } from './theme.js';

/**
 * What the prompt of a new project asks when the folder is not a repository yet (N332, step B2):
 * the pure part (what the daemon's `inspect` and `projects.init.mode` call for, which options each
 * question has and what each one asks the daemon to do) and the view of the question.
 */

/** The kind of folder the question is about: with files, empty, or not there yet. */
export type InitQuestionKind = 'files' | 'empty' | 'missing';

/** What the Producer picks. `cancel` goes back to the browser or the field, opening nothing. */
export type InitOptionId = FolderInitChoice | 'software' | 'cancel';

/**
 * What the prompt does after the inspection of the folder: `open` as before, `refuse` (the folder
 * has files and `projects.init.mode` is `refuse`: say so, open nothing) or `ask` this question.
 */
export type InitVerdict =
  | { readonly action: 'open' }
  | { readonly action: 'refuse' }
  | { readonly action: 'ask'; readonly kind: InitQuestionKind };

/** The verdict for what `POST /v1/folders/inspect` found. */
export function initVerdict(found: Pick<InspectFolderResult, 'state' | 'initMode'>): InitVerdict {
  switch (found.state) {
    case 'repo':
    case 'inside_repo':
      return { action: 'open' };
    case 'files':
      // `commit_all` and `empty_commit` are applied by the daemon on its own.
      if (found.initMode === 'ask') return { action: 'ask', kind: 'files' };
      return { action: found.initMode === 'refuse' ? 'refuse' : 'open' };
    case 'empty':
      return { action: 'ask', kind: 'empty' };
    case 'missing':
      return { action: 'ask', kind: 'missing' };
  }
}

/**
 * [proposta] The options of each question, in order: the first is the one highlighted. For a folder
 * with files, a commit with everything comes first (it is what `git init` plus a first commit
 * usually means, and it is local and reversible); for an empty or missing folder, the software
 * model comes first. `cancel` is always the last.
 */
export function initOptions(kind: InitQuestionKind): readonly InitOptionId[] {
  return kind === 'files'
    ? ['commit_all', 'empty_commit', 'cancel']
    : ['software', 'empty_repo', 'cancel'];
}

/** What an option adds to the open: the software model is `newProject`, the others are the `init`. */
export function initExtra(
  option: Exclude<InitOptionId, 'cancel'>,
): { readonly init: FolderInitChoice } | { readonly newProject: true } {
  return option === 'software' ? { newProject: true } : { init: option };
}

interface InitQuestionProps {
  readonly kind: InitQuestionKind;
  readonly repo: string;
  readonly cursor: number;
  readonly width: number;
}

/** The question: the folder, what is wrong with it and the options, with the cursor on one. */
export function InitQuestion(props: InitQuestionProps): ReactNode {
  const { t } = useTranslation();
  const ask = t as unknown as (key: string, params?: Record<string, string>) => string;
  const options = initOptions(props.kind);
  return (
    <>
      <Text dimColor wrap="truncate">
        {ask('layout.newProject.init.folder', {
          repo: clipStart(props.repo, Math.max(1, props.width - 12)),
        })}
      </Text>
      <Text wrap="wrap">{ask(`layout.newProject.init.ask.${props.kind}`)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Text key={option} wrap="truncate">
            {index === props.cursor ? (
              <Text bold inverse color={TOKEN.accent}>
                {` ${ask(`layout.newProject.init.options.${option}.label`)} `}
              </Text>
            ) : (
              <Text>{` ${ask(`layout.newProject.init.options.${option}.label`)} `}</Text>
            )}
            <Text dimColor>{` ${ask(`layout.newProject.init.options.${option}.detail`)}`}</Text>
          </Text>
        ))}
      </Box>
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate">
        {ask('layout.newProject.init.hint')}
      </Text>
    </>
  );
}
