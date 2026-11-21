// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import { Box, Text } from 'ink';
import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { keyLabel, pairLabel } from '../../keys/labels.js';
import { useRawKeys, type KeyEvent } from '../../keys/use-keymap.js';
import { useTabHost } from '../../layout/tab-host.js';
import type { TabContentProps, TabDefinition } from '../../layout/tab-types.js';
import { fit } from '../../layout/text.js';
import { COLOR, paint } from '../../layout/theme.js';
import { useRenderControl } from '../../render-control.js';
import { useStoreValue } from '../../use-store-value.js';
import { apiOf, type DirectApi } from './api.js';
import { editLine, EMPTY_LINE, splitAtCursor, type LineState } from '../directives/line-input.js';
import { useDirectSessions } from './use-direct.js';
import {
  chosenExecutor,
  chosenWorkspace,
  conversationLines,
  editNew,
  lastActorText,
  openBody,
  openNew,
  sessionLine,
  tailLines,
  type NewState,
  type Say,
  type Tone,
} from './view.js';

/**
 * The tab Direct session (P19 of Phase 7; N44, N190; architecture 5.20). [proposta] The Producer
 * talks to one Actor of the scenario without the Director in between: opens a session with the
 * Executor of the profile list they choose, writes, runs a command of the client (`/...`), stops
 * the turn, promotes the result to a demand or a piece, and closes. What the Actor may do is what
 * the policy of the session says (`direct_session.workspace`); the tab shows the decisions the
 * policy made (a write barred in `readonly`) and never asks the Producer to approve one.
 *
 * Everything goes to the daemon (`/v1/scenarios/:id/direct`, `/v1/direct/:id/...`); the tab reads
 * again when an event `direct.session.*` arrives and, while a turn runs, every few hundred ms.
 */

export interface DirectTabOptions {
  /** The routes of the tab; default: the client of the daemon the TUI is connected to. */
  readonly api?: DirectApi | undefined;
}

type Tone2 = 'info' | 'ok' | 'error';
interface Message {
  readonly tone: Tone2;
  readonly text: string;
}

type Ui =
  | { readonly mode: 'view' }
  | { readonly mode: 'talk'; readonly line: LineState }
  | { readonly mode: 'new'; readonly form: NewState }
  | { readonly mode: 'confirm'; readonly form: NewState };

const VIEW: Ui = { mode: 'view' };

const TONE_COLOR: Readonly<Record<Tone | Tone2, string | undefined>> = {
  plain: undefined,
  info: undefined,
  producer: COLOR.accent,
  actor: undefined,
  dim: undefined,
  ok: COLOR.ok,
  warn: COLOR.warn,
  error: COLOR.error,
};

/** The id of the last event `direct.session.*` of the stream: what makes the tab read again. */
function lastDirectEvent(
  events: readonly { readonly id: number; readonly type: string }[],
): number {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event?.type.startsWith('direct.session.')) return event.id;
  }
  return 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TabProps {
  readonly content: TabContentProps;
  readonly options: DirectTabOptions;
}

function DirectTab({ content, options }: TabProps): ReactNode {
  const { stores, keymap, capture } = useTabHost();
  const { t } = useTranslation();
  const { afterKey } = useRenderControl();
  const { width, height, scenarioId } = content;
  const api = useMemo(() => options.api ?? apiOf(stores.client), [options.api, stores]);
  const say: Say = (key, params) => (params === undefined ? t(key) : t(key, params));

  const signal = useStoreValue(stores.events, (state) => lastDirectEvent(state.events));
  const [pickedId, setPickedId] = useState<string | undefined>(undefined);
  const { sessions, selectedId, detail, loaded, refresh } = useDirectSessions(
    api,
    scenarioId,
    pickedId,
    signal,
  );
  const selected = sessions.find((session) => session.id === selectedId);

  const [ui, setUiState] = useState<Ui>(VIEW);
  const uiRef = useRef<Ui>(VIEW);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const busy = useRef(false);
  const mounted = useRef(true);

  const setUi = (next: Ui): void => {
    uiRef.current = next;
    setUiState(next);
    if (next.mode !== 'view') capture.current = true;
  };

  // The keyboard goes back to the screen only after the key that left the form has been seen by
  // everyone who listens (the `Shell` too), so Enter or Esc does not also act on the panel.
  const leave = (): void => {
    setUi(VIEW);
    queueMicrotask(() => {
      if (uiRef.current.mode === 'view') capture.current = false;
    });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uiRef.current = VIEW;
      capture.current = false;
    };
  }, [capture]);

  const fail = (error: unknown): void => {
    if (!mounted.current) return;
    const code = error instanceof ApiRequestError ? error.code : undefined;
    setMessage({
      tone: 'error',
      text:
        code === 'quota_exhausted'
          ? t('direct.status.quota', { message: errorText(error) })
          : t('direct.status.failed', { message: errorText(error) }),
    });
  };

  /** Runs one command of the daemon; one at a time, so a held key does not repeat it. */
  const act = (run: () => Promise<void>): void => {
    if (busy.current) return;
    busy.current = true;
    run()
      .catch(fail)
      .finally(() => {
        busy.current = false;
      });
  };

  const selectedOpen = selected !== undefined && selected.state !== 'closed';

  const openForm = (): void => {
    if (scenarioId === undefined) {
      setMessage({ tone: 'error', text: t('direct.status.needScenario') });
      return;
    }
    setMessage({ tone: 'info', text: t('direct.status.loadingExecutors') });
    act(async () => {
      let ids: string[] = [];
      try {
        ids = (await api.executors()).map((executor) => executor.id);
      } catch (error) {
        fail(error);
      }
      if (!mounted.current) return;
      setMessage(undefined);
      setUi({ mode: 'new', form: openNew(ids) });
    });
  };

  const openSession = (form: NewState, confirm: boolean): void => {
    if (scenarioId === undefined) return;
    setMessage({ tone: 'info', text: t('direct.status.opening') });
    act(async () => {
      const result = await api.open(scenarioId, openBody(form, confirm));
      if (!mounted.current) return;
      if (result.status === 'confirm') {
        setMessage(undefined);
        setUi({ mode: 'confirm', form });
        return;
      }
      leave();
      if (result.session !== undefined) setPickedId(result.session.id);
      setMessage({
        tone: 'ok',
        text: t('direct.status.opened', { id: result.session?.id ?? '' }),
      });
      refresh();
    });
  };

  const submitLine = (line: LineState): void => {
    const text = line.value.trim();
    if (text === '' || selected === undefined) return;
    setMessage(undefined);
    act(async () => {
      const id = selected.id;
      if (text.startsWith('/')) await api.command(id, text);
      else await api.send(id, text);
      if (!mounted.current) return;
      setUi({ mode: 'talk', line: EMPTY_LINE });
      refresh();
    });
  };

  const promote = (target: 'demand' | 'piece'): void => {
    if (selected === undefined || lastActorText(detail?.items ?? []) === undefined) {
      setMessage({ tone: 'error', text: t('direct.status.nothingToPromote') });
      return;
    }
    act(async () => {
      const result = await api.promote(selected.id, target);
      if (!mounted.current) return;
      setMessage({ tone: 'ok', text: t(`direct.status.promoted.${target}`, { ref: result.ref }) });
      refresh();
    });
  };

  const onKey = (event: KeyEvent): void => {
    const current = uiRef.current;
    if (current.mode === 'talk') {
      if (event.combo === 'Esc') leave();
      else if (event.combo === 'Enter') submitLine(current.line);
      else {
        const line = editLine(current.line, event);
        if (line !== current.line) setUi({ mode: 'talk', line });
      }
      afterKey();
      return;
    }
    if (current.mode === 'new') {
      if (event.combo === 'Esc') leave();
      else if (event.combo === 'Enter') openSession(current.form, false);
      else {
        const form = editNew(current.form, event.combo);
        if (form !== current.form) setUi({ mode: 'new', form });
      }
      afterKey();
      return;
    }
    if (current.mode === 'confirm') {
      if (event.combo === 'Esc') leave();
      else if (event.combo === 'Enter') openSession(current.form, true);
      afterKey();
      return;
    }
    if (event.combo === undefined) return;
    const action = keymap.match(event.combo, ['direct']);
    switch (action) {
      case 'direct.new':
        setMessage(undefined);
        openForm();
        break;
      case 'direct.talk':
        if (!selectedOpen) {
          setMessage({ tone: 'error', text: t('direct.status.needSession') });
        } else {
          setMessage(undefined);
          setUi({ mode: 'talk', line: EMPTY_LINE });
        }
        break;
      case 'direct.cancel':
        if (selected === undefined || (detail?.state ?? selected.state) !== 'running') {
          setMessage({ tone: 'error', text: t('direct.status.noTurn') });
        } else {
          act(async () => {
            await api.cancel(selected.id);
            if (mounted.current) setMessage({ tone: 'ok', text: t('direct.status.cancelled') });
            refresh();
          });
        }
        break;
      case 'direct.close':
        if (!selectedOpen) {
          setMessage({ tone: 'error', text: t('direct.status.needSession') });
        } else {
          act(async () => {
            const result = await api.close(selected.id);
            if (mounted.current) {
              setMessage({
                tone: 'ok',
                text: t(`direct.status.closed.${result.work}`, { branch: result.branch ?? '' }),
              });
            }
            refresh();
          });
        }
        break;
      case 'direct.promoteDemand':
        promote('demand');
        break;
      case 'direct.promotePiece':
        promote('piece');
        break;
      case 'direct.previous':
      case 'direct.next': {
        const delta = action === 'direct.next' ? 1 : -1;
        const at = sessions.findIndex((session) => session.id === selectedId);
        const target = sessions[Math.min(sessions.length - 1, Math.max(0, at + delta))];
        if (target !== undefined) setPickedId(target.id);
        break;
      }
      default:
        return;
    }
    afterKey();
  };
  useRawKeys(onKey, { isActive: content.focused });

  // ---- drawing ----

  const hint = t('direct.tab.hint', {
    new: keyLabel(keymap, 'direct.new') ?? '',
    talk: keyLabel(keymap, 'direct.talk') ?? '',
    cancel: keyLabel(keymap, 'direct.cancel') ?? '',
    close: keyLabel(keymap, 'direct.close') ?? '',
    demand: keyLabel(keymap, 'direct.promoteDemand') ?? '',
    piece: keyLabel(keymap, 'direct.promotePiece') ?? '',
    move: pairLabel(keyLabel(keymap, 'direct.previous'), keyLabel(keymap, 'direct.next')),
  });

  const listed = sessions.slice(0, 5);
  const infoLines: string[] = [];
  if (selected !== undefined) {
    infoLines.push(
      t('direct.tab.info', {
        executor: selected.executor,
        model: selected.model ?? '-',
        workspace: t(`direct.workspace.${selected.workspace}`),
        branch: selected.branch ?? '-',
        turns: selected.turns,
      }),
    );
    if (selected.commands.length > 0) {
      infoLines.push(
        t('direct.tab.commands', { list: selected.commands.map((c) => c.name).join(' ') }),
      );
    }
  }

  const formLines = (state: NewState, confirming: boolean): ReactNode => {
    const executor = chosenExecutor(state);
    const workspace = chosenWorkspace(state);
    const choice = (name: string, many: boolean): string => (many ? `‹ ${name} ›` : name);
    const fields: [string, string, boolean][] = [
      ['executor', t('direct.form.field.executor'), state.field === 'executor'],
      ['workspace', t('direct.form.field.workspace'), state.field === 'workspace'],
    ];
    const values: Record<string, string> = {
      executor: choice(executor ?? t('direct.form.firstExecutor'), state.executors.length > 0),
      workspace: choice(
        workspace === undefined
          ? t('direct.form.configuredWorkspace')
          : t(`direct.workspace.${workspace}`),
        true,
      ),
    };
    return (
      <Box flexDirection="column" width={width} marginBottom={1}>
        <Text bold {...paint(COLOR.accent)} wrap="truncate">
          {fit(t('direct.form.title'), width)}
        </Text>
        {fields.map(([id, label, active]) => (
          <Text
            key={id}
            bold={active}
            {...paint(active ? COLOR.accent : undefined)}
            wrap="truncate"
          >
            {fit(`${active ? '›' : ' '} ${label}: ${values[id] ?? ''}`, width)}
          </Text>
        ))}
        {confirming ? (
          <Text {...paint(COLOR.warn)} wrap="truncate">
            {fit(t('direct.form.confirmScenario'), width)}
          </Text>
        ) : null}
        <Text dimColor wrap="truncate">
          {fit(t(confirming ? 'direct.form.hintConfirm' : 'direct.form.hint'), width)}
        </Text>
      </Box>
    );
  };

  const head = 1 + (message === undefined ? 0 : 1) + listed.length + infoLines.length + 1;
  const formRows = ui.mode === 'new' || ui.mode === 'confirm' ? 6 : 0;
  const inputRows = ui.mode === 'talk' ? 1 : 0;
  const rows = Math.max(3, height - head - formRows - inputRows);
  const lines = detail === undefined ? [] : conversationLines(detail.items, width, say);
  const shown = tailLines(lines, rows);

  const talkLine = ui.mode === 'talk' ? splitAtCursor(ui.line) : undefined;

  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor wrap="truncate">
        {fit(hint, width)}
      </Text>
      {message !== undefined && (
        <Text {...paint(TONE_COLOR[message.tone])} wrap="truncate">
          {fit(message.text, width)}
        </Text>
      )}
      {(ui.mode === 'new' || ui.mode === 'confirm') && formLines(ui.form, ui.mode === 'confirm')}
      {scenarioId === undefined ? (
        <Text dimColor wrap="truncate">
          {fit(t('direct.tab.noScenario'), width)}
        </Text>
      ) : loaded && sessions.length === 0 ? (
        <Text dimColor wrap="truncate">
          {fit(t('direct.tab.empty', { key: keyLabel(keymap, 'direct.new') ?? '' }), width)}
        </Text>
      ) : null}
      {listed.map((session) => (
        <Text
          key={session.id}
          bold={session.id === selectedId}
          dimColor={session.state === 'closed'}
          {...paint(session.id === selectedId ? COLOR.accent : undefined)}
          wrap="truncate"
        >
          {fit(`${session.id === selectedId ? '›' : ' '} ${sessionLine(session, say)}`, width)}
        </Text>
      ))}
      {infoLines.map((line) => (
        <Text key={line} dimColor wrap="truncate">
          {fit(`  ${line}`, width)}
        </Text>
      ))}
      <Text dimColor wrap="truncate">
        {'─'.repeat(Math.max(1, width))}
      </Text>
      {shown.map((line, index) => (
        <Text
          key={index}
          dimColor={line.tone === 'dim'}
          {...paint(TONE_COLOR[line.tone])}
          wrap="truncate"
        >
          {fit(line.text, width)}
        </Text>
      ))}
      {talkLine !== undefined && (
        <Text wrap="truncate">
          {'› '}
          {talkLine.before}
          <Text inverse>{talkLine.under}</Text>
          {talkLine.after}
        </Text>
      )}
    </Box>
  );
}

/** The tab Direct session with its routes; the tests give it a fake API. */
export function createDirectTab(options: DirectTabOptions = {}): TabDefinition {
  return {
    render: (content) => createElement(DirectTab, { content, options }),
  };
}

export const directTab: TabDefinition = createDirectTab();
