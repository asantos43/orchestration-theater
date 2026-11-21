// SPDX-License-Identifier: MPL-2.0
import {
  DEFAULT_UI_REGISTRY,
  translateUiText,
  type ResolvedKeymap,
  type UiRegistry,
  type UiTranslate,
} from '@otheater/client';
import { Box, Text, useInput, usePaste } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSuspendTerminal } from '../mouse/index.js';
import { useRenderControl } from '../render-control.js';
import { type ProducerMessage, draftsInText } from './attachments.js';
import { readClipboardImage, errorMessage } from './clipboard-image.js';
import { atomRanges } from './editor.js';
import {
  editExternally,
  resolveEditorCommand,
  type ExternalEditResult,
} from './external-editor.js';
import { MemoryHistoryStore, type HistoryStore } from './history.js';
import { actionOf, typedText } from './keys.js';
import { layoutBox, type Segment } from './layout.js';
import { createBoxPorts, type BoxPorts } from './ports.js';
import { DEFAULT_INPUT_SETTINGS, type InputSettings } from './settings.js';
import {
  createBoxState,
  reduceBox,
  type BoxContext,
  type BoxEffect,
  type BoxEvent,
  type BoxState,
} from './state.js';

const PROMPT_FIRST = '❯ ';
const PROMPT_NEXT = '  ';

export interface TextBoxProps {
  /** The keymap of the interface (P7): the keys of the box are the actions `input.*` of it. */
  readonly keymap: ResolvedKeymap;
  readonly registry?: UiRegistry | undefined;
  /** `ui.input.*`; the defaults when absent. */
  readonly settings?: InputSettings | undefined;
  /** Where the history of messages lives; in memory when absent. */
  readonly history?: HistoryStore | undefined;
  /** The clipboard, the editor and the files; the real ones when absent. */
  readonly ports?: BoxPorts | undefined;
  /**
   * The Producer sent the message. May be async: when it rejects, the message goes back to the box
   * (if the box is empty) with a line that says so.
   */
  readonly onSubmit: (message: ProducerMessage) => void | Promise<void>;
  /** The text changed (for the owner to keep a draft, or to show something else). */
  readonly onChange?: ((text: string) => void) | undefined;
  /**
   * Enter completes instead of sending when this returns a text for the current one (the / command
   * suggestions of the chat); `undefined` lets Enter send as usual.
   */
  readonly complete?: ((text: string) => string | undefined) | undefined;
  /** How many rows the box takes now (it grows with the text), for the owner to lay out around it. */
  readonly onRows?: ((rows: number) => void) | undefined;
  /** Whether the box has the keyboard (the context `textBox` of the keymap is alive). Default: true. */
  readonly isActive?: boolean | undefined;
}

function styleOf(segment: Segment): { inverse?: boolean; color?: string } {
  if (segment.kind === 'cursor') return { inverse: true };
  if (segment.kind === 'marker') return { color: 'cyan' };
  return {};
}

/**
 * The text box of the Producer (N35, architecture 5.13): the message is written here, with the
 * readline keys, the history, the paste and the attachments. The state and the rules are in
 * `state.ts` (pure); this component turns keys into events and runs what they ask for.
 */
export function TextBox(props: TextBoxProps): ReactNode {
  const { keymap, onSubmit, onChange } = props;
  const registry = props.registry ?? DEFAULT_UI_REGISTRY;
  const settings = props.settings ?? DEFAULT_INPUT_SETTINGS;
  const active = props.isActive ?? true;
  const { t } = useTranslation();
  // The editor of Ctrl+G takes the terminal: the mouse reports are off while it runs (N34).
  const suspendTerminal = useSuspendTerminal();
  const { afterKey } = useRenderControl();

  const ports = useMemo(() => props.ports ?? createBoxPorts(), [props.ports]);
  const history = useMemo(
    () => props.history ?? new MemoryHistoryStore(settings.history.size),
    [props.history, settings.history.size],
  );

  const [state, setState] = useState<BoxState>(() => createBoxState());
  // The latest state, for keys that arrive faster than React renders.
  const current = useRef(state);
  const mounted = useRef(true);
  const temporaryFiles = useRef(new Set<string>());
  const latest = useRef({ settings, ports, history, onSubmit, onChange, suspendTerminal });
  latest.current = { settings, ports, history, onSubmit, onChange, suspendTerminal };

  const dispatch = useCallback((event: BoxEvent): void => {
    if (!mounted.current) return;
    const { settings: s, ports: p, onChange: changed } = latest.current;
    const context: BoxContext = { settings: s, homedir: p.homedir, platform: p.platform };
    const before = current.current.editor.text;
    const step = reduceBox(current.current, event, context);
    current.current = step.state;
    setState(step.state);
    if (step.state.editor.text !== before) changed?.(step.state.editor.text);
    for (const effect of step.effects) runEffect(effect);
  }, []);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  function runEffect(effect: BoxEffect): void {
    const {
      settings: s,
      ports: p,
      history: h,
      onSubmit: send,
      suspendTerminal: suspend,
    } = latest.current;
    const send$ = (event: BoxEvent): void => {
      dispatchRef.current(event);
    };
    switch (effect.type) {
      case 'submit': {
        const { message } = effect;
        void (async () => {
          try {
            await send(message);
          } catch (error) {
            send$({
              type: 'submitFailed',
              message: errorMessage(error),
              sent: { text: message.text, drafts: message.attachments },
            });
          }
        })();
        return;
      }
      case 'saveHistory':
        h.append(effect.text).catch((error: unknown) => {
          send$({ type: 'historyFailed', message: errorMessage(error) });
        });
        return;
      case 'readImage':
        void readClipboardImage(s.image, p.clipboard).then((result) => {
          if (result.kind === 'image') temporaryFiles.current.add(result.path);
          if (!mounted.current && result.kind === 'image') void p.clipboard.discard(result.path);
          send$({ type: 'imageRead', result });
        });
        return;
      case 'resolvePaths':
        void Promise.all(effect.paths.map((path) => p.isFile(path))).then((found) => {
          send$({
            type: 'pathsResolved',
            raw: effect.raw,
            files: found.every(Boolean) ? effect.paths : undefined,
          });
        });
        return;
      case 'editExternally': {
        // Nothing to hand the terminal over for when there is no editor to run.
        if (s.editor === 'off') {
          send$({ type: 'editorDone', result: { kind: 'off' } });
          return;
        }
        if (resolveEditorCommand(p.editor.env, p.editor.platform) === undefined) {
          send$({ type: 'editorDone', result: { kind: 'missing' } });
          return;
        }
        void (async () => {
          let result: ExternalEditResult = { kind: 'failed', message: '' };
          try {
            await suspend(async () => {
              result = await editExternally(effect.text, s.editor, p.editor);
            });
          } catch (error) {
            result = { kind: 'failed', message: errorMessage(error) };
          }
          send$({ type: 'editorDone', result });
        })();
        return;
      }
    }
  }

  // The history of the file, once, when the box appears.
  useEffect(() => {
    mounted.current = true;
    void history.load().then((texts) => {
      dispatchRef.current({ type: 'historyLoaded', texts });
    });
    return () => {
      mounted.current = false;
      for (const file of temporaryFiles.current)
        void ports.clipboard.discard(file).catch(() => undefined);
      temporaryFiles.current.clear();
    };
  }, [history, ports]);

  useInput(
    (input, key) => {
      const id = actionOf(keymap, registry, input, key);
      if (id === 'input.submit' && props.complete !== undefined) {
        const completed = props.complete(current.current.editor.text);
        if (completed !== undefined) {
          dispatch({ type: 'replace', text: completed });
          afterKey();
          return;
        }
      }
      if (id !== undefined) {
        dispatch({ type: 'action', id });
      } else {
        const typed = typedText(input, key);
        if (typed === undefined) return;
        // Several characters at once are a paste from a terminal without bracketed paste.
        dispatch(
          typed.length > 1 ? { type: 'paste', text: typed } : { type: 'text', value: typed },
        );
      }
      afterKey();
    },
    { isActive: active },
  );

  usePaste(
    (text) => {
      dispatch({ type: 'paste', text });
      afterKey();
    },
    { isActive: active },
  );

  const markers = state.drafts.map((draft) => draft.marker);
  const layout = layoutBox(
    state.editor.text,
    state.editor.cursor,
    atomRanges(state.editor.text, markers),
    settings.maxVisibleLines,
  );
  const translate = t as unknown as UiTranslate;
  const attached = draftsInText(state.editor.text, state.drafts).map((draft) => draft.marker);
  const rows =
    layout.lines.length +
    (layout.above > 0 ? 1 : 0) +
    (layout.below > 0 ? 1 : 0) +
    (state.search === undefined ? 0 : 1) +
    (attached.length > 0 ? 1 : 0) +
    (state.status === undefined ? 0 : 1);
  const { onRows } = props;
  useEffect(() => {
    onRows?.(rows);
  }, [onRows, rows]);

  return (
    <Box flexDirection="column">
      {layout.above > 0 && <Text dimColor>{t('input.moreAbove', { count: layout.above })}</Text>}
      {state.search !== undefined && (
        <Text color="yellow">
          {t('input.search.prompt', { query: state.search.query })}
          {state.search.matches === 0 ? ` (${t('input.search.none')})` : ''}
        </Text>
      )}
      {layout.lines.map((segments, index) => (
        <Box key={index}>
          <Text dimColor>{index === 0 && layout.above === 0 ? PROMPT_FIRST : PROMPT_NEXT}</Text>
          <Text>
            {segments.map((segment, at) => (
              <Text key={at} {...styleOf(segment)}>
                {segment.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
      {layout.below > 0 && <Text dimColor>{t('input.moreBelow', { count: layout.below })}</Text>}
      {attached.length > 0 && (
        <Text dimColor>{t('input.attachments', { list: attached.join(' ') })}</Text>
      )}
      {state.status !== undefined && (
        <Text color="yellow">{translateUiText(translate, state.status)}</Text>
      )}
    </Box>
  );
}
