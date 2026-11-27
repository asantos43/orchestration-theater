// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError, needsInitOf } from '@otheater/client';
import type { FolderInitChoice, InspectFolderResult } from '@otheater/protocol';
import { Box } from 'ink';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { useEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from './theme-context.js';
import { Text } from './themed-text.js';
import { useRawKeys, type KeyEvent } from '../keys/use-keymap.js';
import { MouseModalScope } from '../mouse/index.js';
import type { NewProjectPickerMode, NewProjectRepoMode, NewProjectTypeMode } from '../settings.js';
import { fieldStep } from '../tabs/settings/field.js';
import { nodeFolderFs } from './folder-fs.js';
import type { FolderFs } from './folder-picker.js';
import { FolderPicker, PICKER_FIXED_LINES, useFolderPicker } from './folder-picker-view.js';
import { overlayRect, type OverlayFrame } from './overlays.js';
import {
  InitQuestion,
  initExtra,
  initOptions,
  initVerdict,
  type InitQuestionKind,
} from './project-init.js';
import { clipStart } from './text.js';
import { TOKEN } from './theme.js';

/**
 * "New scenario" (P22 of Phase 7, N208 item 1; N329): the prompt that picks the type of the scenario
 * (project, task or chat), asks for its field and opens it by the same route as `ot chat --type`.
 * This file has the pure parts (the types, where the prompt starts, how the typed path is read) and
 * the prompt itself.
 */

/** A type of scenario the prompt shows, and whether the daemon can open it yet. */
export interface ScenarioTypeChoice {
  readonly id: string;
  readonly creatable: boolean;
}

/**
 * The types when the daemon does not say them (a daemon older than `GET /v1/scenario-types`): the
 * three official ones, with the task off, as the daemon of N329 creates them.
 */
export const FALLBACK_SCENARIO_TYPES: readonly ScenarioTypeChoice[] = [
  { id: 'project', creatable: true },
  { id: 'task', creatable: false },
  { id: 'chat', creatable: true },
];

/**
 * What the prompt opens: a project on a repository or a chat, with an optional name. The project
 * may carry what the Producer chose for a folder that is not a repository yet (N332): `init` for
 * the daemon to turn it into one, or `newProject` to start from the software model.
 */
export type NewScenarioRequest =
  | {
      readonly type: 'project';
      readonly repo: string;
      readonly init?: FolderInitChoice;
      readonly newProject?: true;
    }
  | { readonly type: 'chat'; readonly name?: string };

/** Whether the TUI knows how to ask for a type: the daemon may list a type the TUI has no field for. */
function askable(id: string): id is NewProjectTypeMode {
  return id === 'project' || id === 'chat';
}

/** The type the prompt starts on: the one asked for when it can be opened, or else the first that can. */
export function startType(
  types: readonly ScenarioTypeChoice[],
  wanted: string,
): NewProjectTypeMode | undefined {
  const open = types.filter((type) => type.creatable && askable(type.id));
  const hit = open.find((type) => type.id === wanted) ?? open[0];
  return hit === undefined ? undefined : (hit.id as NewProjectTypeMode);
}

/** The next type that can be opened, after (`step` 1) or before (-1) `current`, going around. */
export function stepType(
  types: readonly ScenarioTypeChoice[],
  current: string,
  step: 1 | -1,
): NewProjectTypeMode {
  const at = types.findIndex((type) => type.id === current);
  for (let move = 1; move <= types.length; move++) {
    const type = types[(((at + step * move) % types.length) + types.length) % types.length];
    if (type !== undefined && type.creatable && askable(type.id)) return type.id;
  }
  return current as NewProjectTypeMode;
}

/** The request the field stands for, or the catalog key of what is missing. */
export function newScenarioRequest(
  type: NewProjectTypeMode,
  text: string,
  cwd: string,
  home: string = homedir(),
): NewScenarioRequest | { readonly missing: string } {
  if (type === 'chat') {
    const name = text.trim();
    return name === '' ? { type: 'chat' } : { type: 'chat', name };
  }
  const repo = resolveRepo(text, cwd, home);
  return repo === '' ? { missing: 'layout.newProject.noRepo' } : { type: 'project', repo };
}

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
  repo: string | undefined,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  if (repo !== undefined && error instanceof ApiRequestError && error.code === 'invalid_input') {
    return t('layout.newProject.badRepo', { repo });
  }
  return t('layout.newProject.failed', {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** [proposta] The overlay of the browser: wider and taller than the one of the field. */
const BROWSER_WIDTH = 84;
const BROWSER_HEIGHT = 26;
/** The rows of the overlay that are not the list: border, title, types, folder, root, filter, status and hint. */
const BROWSER_CHROME = 2 + 3 + PICKER_FIXED_LINES + 2 + 2;
/** [proposta] The overlay of the question: the folder, the text, three options and the hint. */
const QUESTION_HEIGHT = 12;
/** [proposta] The fewest rows of the list: below it the browser has no room to be useful. */
const LIST_MIN = 3;

export interface NewProjectPromptProps {
  readonly screen: OverlayFrame;
  /** What the field of the repository starts with. */
  readonly initial: string;
  /** The type the prompt starts on (`ui.newProject.type`, or `project` for `/new project`). */
  readonly initialType: string;
  /** The folder a relative path starts at. */
  readonly cwd: string;
  /** Reads the types from the daemon; without it, or when it fails, the prompt shows the fallback. */
  readonly types?: () => Promise<readonly ScenarioTypeChoice[]>;
  /** Opens the scenario; throws what went wrong. */
  readonly open: (request: NewScenarioRequest) => Promise<void>;
  /**
   * Tells what the folder of a project is before it is opened (`POST /v1/folders/inspect`, N332).
   * Without it, or when it fails (a daemon without the route), the project is opened as it always was.
   */
  readonly inspect?: (path: string) => Promise<InspectFolderResult>;
  readonly onClose: () => void;
  /** The shell's flag that a field has the keyboard: set while the prompt is on screen. */
  readonly capture: RefObject<boolean>;
  /** `ui.newProject.picker`: the project is asked in the folder browser, or in the field of the path (N332). */
  readonly picker?: NewProjectPickerMode;
  /** `ui.newProject.hidden`: the browser starts showing the hidden folders. */
  readonly showHidden?: boolean;
  /** The folders of the projects already open: shortcuts of the browser. */
  readonly projects?: readonly string[];
  /** `ui.newProject.favorites`: the folders the person marked. */
  readonly favorites?: readonly string[];
  /** The person marked or unmarked a favorite: the new list, to save. */
  readonly onFavorites?: (favorites: readonly string[]) => void;
  /** The prompt opens in the field of the path (a path was given: `/new project <path>`), not in the browser. */
  readonly startInField?: boolean;
  /** The disk the browser reads; the real one by default. */
  readonly fs?: FolderFs;
}

const NO_FOLDERS: readonly string[] = [];

/** The question of what to do with a folder that is not a repository (N332): what it is about and where the cursor is. */
interface InitQuestionState {
  readonly kind: InitQuestionKind;
  readonly repo: string;
  readonly cursor: number;
}

/** The state the keys read, kept in step with every key. */
interface Latest {
  readonly type: NewProjectTypeMode;
  readonly texts: Record<NewProjectTypeMode, string>;
  readonly types: readonly ScenarioTypeChoice[];
  readonly moved: boolean;
  readonly mode: 'browser' | 'field';
  readonly question: InitQuestionState | undefined;
}

/**
 * The prompt of a new scenario: the row of the types (Tab and Shift+Tab move, a type the daemon
 * cannot open yet is shown off and skipped) and a one-line field, over the screen. The project asks
 * for the repository; the chat asks for a name, which may stay empty.
 */
export function NewProjectPrompt(props: NewProjectPromptProps): ReactNode {
  const { t } = useTranslation();
  const [types, setTypes] = useState<readonly ScenarioTypeChoice[]>(FALLBACK_SCENARIO_TYPES);
  const [type, setType] = useState<NewProjectTypeMode>(
    () => startType(FALLBACK_SCENARIO_TYPES, props.initialType) ?? 'chat',
  );
  // One text per type, so going from the project to the chat and back keeps what was typed.
  const [texts, setTexts] = useState<Record<NewProjectTypeMode, string>>({
    project: props.initial,
    chat: '',
  });
  // The latest state, kept in step with every key, so keys that arrive faster than a render (a
  // paste, a burst of typing) each act on what the one before left.
  // `moved`: the person already changed the type, so the types read later do not move it back.
  const browser = (props.picker ?? 'browser') === 'browser';
  // N332: the project starts in the browser of the folders unless the path was given; Ctrl+O (and `/`)
  // go between the two. The chat has no folder: it always has its field.
  const [mode, setMode] = useState<'browser' | 'field'>(
    browser && props.startInField !== true ? 'browser' : 'field',
  );
  // N332: the question of what to do with a folder that is not a repository (`undefined`: none).
  const [question, setQuestion] = useState<InitQuestionState | undefined>(undefined);
  const latest = useRef<Latest>({ type, texts, types, moved: false, mode, question: undefined });
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const { capture, types: readTypes, initialType } = props;
  useEffect(() => {
    capture.current = true;
    mounted.current = true;
    return () => {
      capture.current = false;
      mounted.current = false;
    };
  }, [capture]);
  useEffect(() => {
    if (readTypes === undefined) return;
    readTypes().then(
      (read) => {
        if (!mounted.current || read.length === 0) return;
        const now = latest.current;
        const start = startType(read, now.moved ? now.type : initialType);
        if (start === undefined) return;
        latest.current = { ...latest.current, types: read, type: start };
        setTypes(read);
        setType(start);
      },
      () => undefined,
    );
  }, [readTypes, initialType]);

  const diskFs = useMemo(() => props.fs ?? nodeFolderFs(), [props.fs]);
  const picker = useFolderPicker({
    fs: diskFs,
    enabled: browser,
    wanted: resolveRepo(props.initial, props.cwd, diskFs.home),
    showHidden: props.showHidden ?? false,
    projects: props.projects ?? NO_FOLDERS,
    favorites: props.favorites ?? NO_FOLDERS,
    height: listHeight(props.screen.rows),
  });

  const submit = (chosen?: string): void => {
    const now = latest.current;
    const request = newScenarioRequest(
      now.type,
      chosen ?? now.texts[now.type],
      props.cwd,
      diskFs.home,
    );
    if ('missing' in request) {
      setError(t(request.missing));
      return;
    }
    setBusy(true);
    setError(undefined);
    const { inspect } = props;
    if (request.type === 'project' && inspect !== undefined) {
      const project = request;
      inspect(project.repo).then(
        (found) => {
          if (mounted.current) proceed(project, found);
        },
        // A daemon without the route, or an inspection that failed: the open says what is wrong, as before.
        () => {
          if (mounted.current) launch(project);
        },
      );
      return;
    }
    launch(request);
  };

  const ask = (next: InitQuestionState | undefined): void => {
    latest.current = { ...latest.current, question: next };
    setQuestion(next);
  };

  /** Opens the request; a folder that needs the Producer's choice (it changed since the inspection) asks it. */
  const launch = (request: NewScenarioRequest): void => {
    setBusy(true);
    setError(undefined);
    props.open(request).then(
      () => {
        if (mounted.current) props.onClose();
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setBusy(false);
        if (
          request.type === 'project' &&
          request.init === undefined &&
          needsInitOf(failure) !== undefined
        ) {
          ask({ kind: 'files', repo: request.repo, cursor: 0 });
          return;
        }
        setError(
          openFailure(failure, request.type === 'project' ? request.repo : undefined, t as never),
        );
      },
    );
  };

  /** What the inspection of the folder says to do (N332): open it, refuse, or ask the Producer. */
  const proceed = (
    request: NewScenarioRequest & { readonly type: 'project' },
    found: InspectFolderResult,
  ): void => {
    const verdict = initVerdict(found);
    if (verdict.action === 'open') {
      launch(request);
      return;
    }
    setBusy(false);
    if (verdict.action === 'refuse') {
      setError(
        (t as unknown as Translate)('layout.newProject.init.refused', { repo: request.repo }),
      );
    } else {
      ask({ kind: verdict.kind, repo: request.repo, cursor: 0 });
    }
  };

  // The keys of the question (N332): the arrows and Enter pick, Esc goes back; nothing else acts.
  const questionKey = (event: KeyEvent, asked: InitQuestionState): void => {
    const options = initOptions(asked.kind);
    switch (event.combo) {
      case 'Up':
      case 'Down': {
        const step = event.combo === 'Up' ? -1 : 1;
        ask({ ...asked, cursor: (asked.cursor + step + options.length) % options.length });
        break;
      }
      case 'Enter': {
        const option = options[asked.cursor];
        ask(undefined);
        if (option !== undefined && option !== 'cancel') {
          launch({ type: 'project', repo: asked.repo, ...initExtra(option) });
        }
        break;
      }
      case 'Esc':
        ask(undefined);
        break;
    }
  };

  const goTo = (next: 'browser' | 'field'): void => {
    latest.current = { ...latest.current, mode: next };
    setMode(next);
  };

  // The keys of the browser (N332): the model decides, the prompt does what it asks.
  const browserKey = (event: KeyEvent): void => {
    if (error !== undefined) setError(undefined);
    const effect = picker.press(event);
    switch (effect?.type) {
      case 'close':
        props.onClose();
        break;
      case 'choose': {
        const now = latest.current;
        const texts = { ...now.texts, project: effect.path };
        latest.current = { ...now, texts };
        setTexts(texts);
        submit(effect.path);
        break;
      }
      case 'path': {
        // The field starts on the folder the browser was on, to edit from there [proposta].
        const now = latest.current;
        const texts = { ...now.texts, project: picker.current().dir };
        latest.current = { ...now, texts };
        setTexts(texts);
        goTo('field');
        break;
      }
      case 'favorites':
        props.onFavorites?.(effect.favorites);
        break;
      case undefined:
        break;
    }
  };

  useRawKeys((event: KeyEvent) => {
    if (busy) return;
    const now = latest.current;
    if (now.question !== undefined) {
      questionKey(event, now.question);
      return;
    }
    if (event.combo === 'Tab' || event.combo === 'Shift+Tab') {
      const next = stepType(now.types, now.type, event.combo === 'Tab' ? 1 : -1);
      latest.current = { ...now, type: next, moved: true };
      setType(next);
      if (error !== undefined) setError(undefined);
      return;
    }
    if (now.type === 'project' && browser) {
      if (now.mode === 'browser') {
        browserKey(event);
        return;
      }
      if (event.combo === 'Ctrl+O') {
        // Back to the browser, on the folder the field names [proposta].
        picker.reset(resolveRepo(now.texts.project, props.cwd, diskFs.home));
        if (error !== undefined) setError(undefined);
        goTo('browser');
        return;
      }
    }
    const step = fieldStep(now.texts[now.type], event.combo, event.data);
    if (step.done === 'cancel') {
      props.onClose();
      return;
    }
    if (error !== undefined) setError(undefined);
    if (step.done === 'submit') submit();
    else {
      const nextTexts = { ...now.texts, [now.type]: step.value };
      latest.current = { ...now, texts: nextTexts };
      setTexts(nextTexts);
    }
  });

  const palette = useTheme();
  const browsing = browser && type === 'project' && mode === 'browser' && question === undefined;
  const rect = overlayRect(
    props.screen,
    browsing
      ? { width: BROWSER_WIDTH, height: BROWSER_HEIGHT }
      : { width: 72, height: question === undefined ? 11 : QUESTION_HEIGHT },
  );
  const inner = Math.max(1, rect.width - 4);
  const value = texts[type];
  // Off: the daemon cannot open it yet, or the TUI has no field for it yet (the task before Phase 9b).
  const off = types.filter((choice) => !choice.creatable || !askable(choice.id));
  const status = (
    <>
      {busy && (
        <Text color={TOKEN.warn} wrap="truncate">
          {t('layout.newProject.opening')}
        </Text>
      )}
      {error !== undefined && (
        <Text color={TOKEN.error} wrap="wrap">
          {error}
        </Text>
      )}
    </>
  );
  return (
    <Box
      position="absolute"
      marginLeft={rect.x}
      marginTop={rect.y}
      width={rect.width}
      height={rect.height}
      borderStyle="round"
      borderColor={palette.resolve(TOKEN.borderActive)}
      backgroundColor={palette.resolve(TOKEN.overlay)}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={TOKEN.accent} wrap="truncate">
        {t('layout.newProject.title')}
      </Text>
      <MouseModalScope>
        {question !== undefined ? (
          <InitQuestion
            kind={question.kind}
            repo={question.repo}
            cursor={question.cursor}
            width={inner}
          />
        ) : (
          <>
            <Text wrap="truncate">
              {types.map((choice, index) => (
                <Text key={choice.id}>
                  {index > 0 ? '  ' : ''}
                  {choice.id === type ? (
                    <Text
                      bold
                      inverse
                      color={TOKEN.accent}
                    >{` ${typeLabel(choice.id, t as never)} `}</Text>
                  ) : (
                    <Text
                      dimColor={off.includes(choice)}
                    >{` ${typeLabel(choice.id, t as never)} `}</Text>
                  )}
                </Text>
              ))}
            </Text>
            <Text dimColor wrap="truncate">
              {off.length === 0
                ? ' '
                : off.map((choice) => typeOff(choice.id, t as never)).join(' · ')}
            </Text>
            {browsing ? (
              <>
                <FolderPicker
                  state={picker.state}
                  rows={picker.rows}
                  width={inner}
                  height={listHeight(props.screen.rows)}
                />
                <Box flexDirection="column" height={2}>
                  {status}
                </Box>
                <Box flexGrow={1} />
                <Text dimColor wrap="truncate">
                  {t('layout.newProject.picker.hintMove')}
                </Text>
                <Text dimColor wrap="truncate">
                  {t('layout.newProject.picker.hintMore')}
                </Text>
              </>
            ) : (
              <>
                <Text dimColor wrap="truncate">
                  {t(type === 'chat' ? 'layout.newProject.nameLabel' : 'layout.newProject.label')}
                </Text>
                <Text wrap="truncate">
                  <Text color={TOKEN.accent}>{'> '}</Text>
                  {clipStart(value, Math.max(1, inner - 3))}
                  {busy ? '' : <Text caret> </Text>}
                </Text>
                {status}
                <Box flexGrow={1} />
                <Text dimColor wrap="truncate">
                  {t(
                    browser && type === 'project'
                      ? 'layout.newProject.hintField'
                      : 'layout.newProject.hint',
                  )}
                </Text>
              </>
            )}
          </>
        )}
      </MouseModalScope>
    </Box>
  );
}

/** The rows of the list of the browser on a screen of `rows` rows: what the overlay leaves after its own lines. */
export function listHeight(rows: number): number {
  const overlay = Math.max(5, Math.min(BROWSER_HEIGHT, rows - 2));
  return Math.max(LIST_MIN, overlay - BROWSER_CHROME);
}

type Translate = (key: string, params?: Record<string, string>) => string;

/** The name of a type in the catalog; a type the catalog does not know shows its id. */
function typeLabel(id: string, t: Translate): string {
  return askable(id) || id === 'task' ? t(`layout.newProject.types.${id}`) : id;
}

/** Why a type is off: the task says the phase it comes with; another type says only that it is off. */
function typeOff(id: string, t: Translate): string {
  return id === 'task'
    ? t('layout.newProject.taskOff')
    : t('layout.newProject.typeOff', { type: typeLabel(id, t) });
}
