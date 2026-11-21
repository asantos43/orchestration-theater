// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import { Box, Text } from 'ink';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { useEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useRawKeys, type KeyEvent } from '../keys/use-keymap.js';
import { MouseModalScope } from '../mouse/index.js';
import type { NewProjectRepoMode } from '../settings.js';
import { fieldStep } from '../tabs/settings/field.js';
import { overlayRect, type OverlayFrame } from './overlays.js';
import { clip } from './text.js';
import { COLOR } from './theme.js';

/**
 * "New project" (P22 of Phase 7, N208 item 1): the prompt that asks for the repository and opens
 * the `project` scenario by the same route as `ot chat --type project --repo .`. This file has the
 * pure parts (where the prompt starts, how the typed path is read) and the prompt itself.
 */

/** The root of the Git repository `folder` is in, or `folder` itself when it is in none. */
export function gitRootOf(folder: string): string {
  let current = folder;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return folder;
    current = parent;
  }
}

/** What the prompt starts with (`ui.newProject.repo`): the folder the TUI opened in, its Git root, or nothing. */
export function initialRepo(mode: NewProjectRepoMode, cwd: string): string {
  switch (mode) {
    case 'cwd':
      return cwd;
    case 'git_root':
      return gitRootOf(cwd);
    case 'empty':
      return '';
  }
}

/**
 * The absolute path a typed repository stands for: `~` is the home folder, a relative path starts
 * at the folder the TUI opened in. Empty text stays empty.
 */
export function resolveRepo(text: string, cwd: string, home: string = homedir()): string {
  const typed = text.trim();
  if (typed === '') return '';
  if (typed === '~') return home;
  if (typed.startsWith('~/') || typed.startsWith('~\\')) return resolve(home, typed.slice(2));
  return resolve(cwd, typed);
}

/** The text of a failed open, in the catalog: a repository the daemon refused, or the other failures. */
export function openFailure(
  error: unknown,
  repo: string,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  if (error instanceof ApiRequestError && error.code === 'invalid_input') {
    return t('layout.newProject.badRepo', { repo });
  }
  return t('layout.newProject.failed', {
    message: error instanceof Error ? error.message : String(error),
  });
}

export interface NewProjectPromptProps {
  readonly screen: OverlayFrame;
  /** What the field starts with. */
  readonly initial: string;
  /** The folder a relative path starts at. */
  readonly cwd: string;
  /** Opens the project on the repository (an absolute path); throws what went wrong. */
  readonly open: (repo: string) => Promise<void>;
  readonly onClose: () => void;
  /** The shell's flag that a field has the keyboard: set while the prompt is on screen. */
  readonly capture: RefObject<boolean>;
}

/** The prompt of "new project": a one-line field for the repository, over the screen. */
export function NewProjectPrompt(props: NewProjectPromptProps): ReactNode {
  const { t } = useTranslation();
  const [value, setValue] = useState(props.initial);
  // The latest value, kept in step with every key, so keys that arrive faster than a render (a
  // paste, a burst of typing) each act on the text the one before left.
  const latest = useRef(props.initial);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const { capture } = props;
  useEffect(() => {
    capture.current = true;
    mounted.current = true;
    return () => {
      capture.current = false;
      mounted.current = false;
    };
  }, [capture]);

  const submit = (): void => {
    const repo = resolveRepo(latest.current, props.cwd);
    if (repo === '') {
      setError(t('layout.newProject.noRepo'));
      return;
    }
    setBusy(true);
    setError(undefined);
    props.open(repo).then(
      () => {
        if (mounted.current) props.onClose();
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setBusy(false);
        setError(openFailure(failure, repo, t as never));
      },
    );
  };

  useRawKeys((event: KeyEvent) => {
    if (busy) return;
    const step = fieldStep(latest.current, event.combo, event.data);
    if (step.done === 'cancel') {
      props.onClose();
      return;
    }
    if (error !== undefined) setError(undefined);
    if (step.done === 'submit') submit();
    else {
      latest.current = step.value;
      setValue(step.value);
    }
  });

  const rect = overlayRect(props.screen, { width: 72, height: 10 });
  const inner = Math.max(1, rect.width - 4);
  return (
    <Box
      position="absolute"
      marginLeft={rect.x}
      marginTop={rect.y}
      width={rect.width}
      height={rect.height}
      borderStyle="round"
      borderColor={COLOR.borderActive}
      backgroundColor={COLOR.overlay}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={COLOR.accent} wrap="truncate">
        {t('layout.newProject.title')}
      </Text>
      <MouseModalScope>
        <Text dimColor wrap="truncate">
          {t('layout.newProject.label')}
        </Text>
        <Text wrap="truncate">
          <Text color={COLOR.accent}>{'> '}</Text>
          {clip(value, Math.max(1, inner - 3))}
          {busy ? '' : <Text inverse> </Text>}
        </Text>
        {busy && (
          <Text color={COLOR.warn} wrap="truncate">
            {t('layout.newProject.opening')}
          </Text>
        )}
        {error !== undefined && (
          <Text color={COLOR.error} wrap="wrap">
            {error}
          </Text>
        )}
        <Box flexGrow={1} />
        <Text dimColor wrap="truncate">
          {t('layout.newProject.hint')}
        </Text>
      </MouseModalScope>
    </Box>
  );
}
