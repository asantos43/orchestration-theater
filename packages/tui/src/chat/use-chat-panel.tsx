// SPDX-License-Identifier: MPL-2.0
import { API_ROUTES, type ApiSlashCommand } from '@otheater/protocol';
import type { ApiClient, DaemonStores } from '@otheater/client';
import { Box, Text } from 'ink';
import { randomUUID } from 'node:crypto';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { bindAttachments, TextBox, type HistoryStore, type InputSettings } from '../input/index.js';
import type { KeyEvent, TuiKeymap } from '../keys/use-keymap.js';
import { keyLabel } from '../keys/labels.js';
import type { ChatMessage } from '../layout/chat.js';
import { clip } from '../layout/text.js';
import type { UiChatSettings } from '../settings.js';
import { useStoreValue } from '../use-store-value.js';
import {
  buildCard,
  cardKey,
  cardKeyOf,
  cardLines,
  createCardState,
  type CardModel,
  type CardState,
  type CardTexts,
} from './card.js';
import { messagesOf, waitReason, type Translate } from './lines.js';
import { createChatState } from './model.js';
import { ChatSession, type ChatSocketLike } from './session.js';
import { completionOf, suggestionsFor, typingCommandName } from './suggest.js';

/** What the shell hands to the chat: the connection and the settings. */
export interface ChatPanelConfig {
  /** The client of the daemon; without it the chat has nothing to talk to and says so. */
  readonly client: ApiClient | undefined;
  /** How the sockets of the chat are made (tests give a fake `WebSocket` and fast retries). */
  readonly socket?: Parameters<ApiClient['chat']>[1] | undefined;
  readonly chat: UiChatSettings;
  readonly input: InputSettings;
  /** Where the history of messages lives; in memory when absent. */
  readonly history?: HistoryStore | undefined;
}

export interface ChatPanelProps {
  readonly stores: DaemonStores;
  readonly config: ChatPanelConfig;
  readonly scenarioId: string | undefined;
  readonly keymap: TuiKeymap;
  /** Width of the chat inside its frame. */
  readonly width: number;
  /** Rows of the body of the screen (the chat takes all of them). */
  readonly height: number;
  /** The chat has the keyboard: it is the focused area and no overlay is open. */
  readonly active: boolean;
}

export interface ChatPanel {
  readonly messages: readonly ChatMessage[];
  /** What the chat adds to its state line (stage, decisions, Director, waits, connection). */
  readonly stateParts: readonly string[];
  /** The decision card or the confirmation has the keyboard: keys come from the context `decision`. */
  readonly decisionFocused: boolean;
  /** Rows the input region takes (card, suggestions and box). */
  readonly inputRows: number;
  readonly input: ReactNode;
  /** A key of the card or of the confirmation; true when it was theirs. */
  readonly onKey: (event: KeyEvent) => boolean;
  /** An action of the registry that belongs to the chat; true when it was handled. */
  readonly onAction: (actionId: string) => boolean;
}

const NO_STATE = createChatState();
const NO_SUBSCRIBE = (): (() => void) => () => undefined;
const NO_COMMANDS: readonly ApiSlashCommand[] = [];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useChatPanel(props: ChatPanelProps): ChatPanel {
  const { stores, config, scenarioId, keymap } = props;
  const { client } = config;
  const { t: translate, i18n } = useTranslation();
  const t = translate as unknown as Translate;
  const [, setTick] = useState(0);
  const redraw = useCallback((): void => {
    setTick((n) => n + 1);
  }, []);

  // ---- The sessions: one per scenario, kept while the TUI runs --------------------------------
  const sessions = useRef(new Map<string, ChatSession>());
  const owner = useRef<ApiClient | undefined>(undefined);
  const socketOptions = config.socket;
  const queueMode = config.chat.queue;
  const session = useMemo((): ChatSession | undefined => {
    if (scenarioId === undefined || client === undefined) return undefined;
    if (owner.current !== client) {
      for (const old of sessions.current.values()) old.dispose();
      sessions.current.clear();
      owner.current = client;
    }
    const known = sessions.current.get(scenarioId);
    if (known !== undefined) return known;
    const made = new ChatSession({
      open: (resumeFrom): ChatSocketLike =>
        client.chat(scenarioId, {
          ...socketOptions,
          ...(resumeFrom === undefined ? {} : { resumeFrom }),
        }),
      now: () => Date.now(),
      queue: queueMode,
    });
    sessions.current.set(scenarioId, made);
    return made;
  }, [client, scenarioId, socketOptions, queueMode]);
  useEffect(() => {
    session?.setQueueMode(queueMode);
  }, [session, queueMode]);
  useEffect(() => {
    if (session === undefined) return undefined;
    session.connect();
    return () => {
      session.disconnect();
    };
  }, [session]);
  useEffect(
    () => () => {
      for (const old of sessions.current.values()) old.dispose();
      sessions.current.clear();
    },
    [],
  );

  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? NO_SUBSCRIBE(),
    [session],
  );
  const state = useSyncExternalStore(subscribe, () => session?.state ?? NO_STATE);

  const messages = useMemo(() => messagesOf(t, state.entries), [t, state.entries]);

  // ---- The decision card ----------------------------------------------------------------------
  const ask = state.asks[0];
  const answering = ask !== undefined && state.answering === ask.decisionId;
  const model = useMemo((): CardModel | undefined => {
    if (ask === undefined) return undefined;
    const texts: CardTexts = {
      title: t(`layout.chat.card.title.${ask.kind.replace(/\./gu, '_')}`, {
        defaultValue: t('layout.chat.card.title.default'),
      }),
      other: t('layout.chat.card.other'),
      keepPrompt: t('layout.chat.card.keepPrompt'),
      option: (id) => t(`layout.chat.card.option.${id}`, { defaultValue: id }),
      idea: (id, text) => t('layout.chat.card.idea', { id, text }),
      leftOut: (id, reason, question) =>
        t('layout.chat.card.leftOut', {
          id,
          reason,
          question: question === '' ? '' : ` - ${question}`,
        }),
      need: (need) => t('layout.chat.card.need', { need }),
    };
    return buildCard(ask, texts);
    // The card is rebuilt when the ask changes or the language does.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ask` is compared by its id
  }, [ask?.decisionId, t]);
  const card = useRef<{ id: string; state: CardState } | undefined>(undefined);
  if (model !== undefined && card.current?.id !== model.decisionId) {
    card.current = { id: model.decisionId, state: createCardState(model) };
  }
  if (model === undefined) card.current = undefined;
  const cardState = card.current?.state;

  // Auto: the card has the keyboard until set aside. Manual: it has it only after being opened.
  const toggled = useRef(new Set<string>());
  const auto = config.chat.decisionFocus === 'auto';
  const showCard = model !== undefined && !answering;
  const isAside = (id: string): boolean =>
    auto ? toggled.current.has(id) : !toggled.current.has(id);
  const cardFocused = showCard && props.active && !isAside(model.decisionId);
  const confirmFocused = state.confirm !== undefined && props.active;

  // ---- The box, the / suggestions --------------------------------------------------------------
  const [text, setText] = useState('');
  const [boxRows, setBoxRows] = useState(1);
  const [commands, setCommands] = useState<readonly ApiSlashCommand[]>(NO_COMMANDS);
  const [picked, setPicked] = useState(0);
  const lang = i18n.language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
  const suggesting =
    config.chat.suggestions > 0 &&
    client !== undefined &&
    scenarioId !== undefined &&
    typingCommandName(text);
  useEffect(() => {
    if (!suggesting || client === undefined || scenarioId === undefined) return undefined;
    let live = true;
    client
      .call(API_ROUTES.listCommands, { query: { scenario: scenarioId, lang } })
      .then((result) => {
        if (live) setCommands(result.commands);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [suggesting, client, scenarioId, lang]);
  const suggestions = useMemo(
    () => (suggesting ? suggestionsFor(commands, text, config.chat.suggestions) : []),
    [suggesting, commands, text, config.chat.suggestions],
  );
  const at = Math.min(picked, Math.max(0, suggestions.length - 1));
  const latest = useRef({ suggestions, at });
  latest.current = { suggestions, at };
  const complete = useCallback((current: string): string | undefined => {
    const { suggestions: list, at: index } = latest.current;
    const chosen = list[index];
    return chosen === undefined || !typingCommandName(current) ? undefined : completionOf(chosen);
  }, []);
  const onChange = useCallback((next: string): void => {
    setText(next);
    setPicked(0);
  }, []);

  const upload = useMemo(
    () =>
      client === undefined || scenarioId === undefined
        ? undefined
        : (
            body: Parameters<typeof bindAttachments>[1] extends (b: infer B) => unknown ? B : never,
          ) =>
            client.call(API_ROUTES.addAttachment, {
              params: { scenarioId },
              body,
              headers: { 'idempotency-key': randomUUID() },
            }),
    [client, scenarioId],
  );
  const submit = useCallback(
    async (message: Parameters<typeof bindAttachments>[0]): Promise<void> => {
      if (session === undefined || upload === undefined) {
        throw new Error(t('layout.chat.noConnection'));
      }
      const bound = await bindAttachments(message, upload);
      session.submit(bound.text, bound.attachments);
    },
    [session, upload, t],
  );

  // ---- What it says of the scenario -------------------------------------------------------------
  const scenarioState = useStoreValue(stores.scenarios, (s) =>
    scenarioId === undefined ? undefined : s.byId[scenarioId]?.directorState,
  );
  const plays = useStoreValue(stores.plays, (s) => s.byId);
  const pending = useStoreValue(stores.decisions, (s) =>
    scenarioId === undefined ? 0 : (s.byScenario[scenarioId]?.length ?? 0),
  );
  const stage = useMemo((): string | undefined => {
    let found: { state: string; updatedAt: number } | undefined;
    for (const candidate of Object.values(plays)) {
      if (candidate.scenarioId !== scenarioId || candidate.finishedAt !== null) continue;
      if (found === undefined || candidate.updatedAt > found.updatedAt) found = candidate;
    }
    return found?.state;
  }, [plays, scenarioId]);
  const stopKey = keyLabel(keymap, 'chat.stop') ?? '';
  const openKey = keyLabel(keymap, 'decision.open') ?? '';
  const stateParts = useMemo((): string[] => {
    const parts: string[] = [];
    if (stage !== undefined) {
      parts.push(
        t('layout.chat.stage', {
          state: t(`layout.chat.stageName.${stage}`, { defaultValue: stage }),
        }),
      );
    }
    if (pending > 0) parts.push(t('layout.chat.pending', { count: pending }));
    if (scenarioState === 'asleep') parts.push(t('layout.chat.director.asleep'));
    else if (state.busy) {
      parts.push(
        t(
          config.chat.esc === 'stop'
            ? 'layout.chat.director.turnStop'
            : 'layout.chat.director.turn',
          {
            key: stopKey,
          },
        ),
      );
    } else parts.push(t('layout.chat.director.active'));
    const wait = state.waits[0];
    if (wait !== undefined) parts.push(t('layout.chat.waits', { what: waitReason(t, wait) }));
    if (state.connection !== 'open' && scenarioId !== undefined) {
      parts.push(t(`layout.chat.connection.${state.connection}`));
    }
    return parts;
  }, [
    t,
    stage,
    pending,
    scenarioState,
    state.busy,
    state.waits,
    state.connection,
    config.chat.esc,
    stopKey,
    scenarioId,
  ]);

  // ---- Keys -------------------------------------------------------------------------------------
  const failed = (error: unknown): void => {
    session?.local('sendFailed', { message: errorText(error) });
  };

  const onKey = (event: KeyEvent): boolean => {
    if (session === undefined) return false;
    const { confirm } = state;
    if (confirm !== undefined) {
      if (event.combo === 'Enter') {
        try {
          session.sendCommand(confirm.text, true);
        } catch (error) {
          failed(error);
        }
        return true;
      }
      if (event.combo === 'Esc') {
        session.cancelConfirm();
        return true;
      }
      return false;
    }
    const current = card.current;
    if (!cardFocused || model === undefined || current === undefined) return false;
    const key = cardKeyOf(event);
    if (key === undefined) return false;
    const result = cardKey(model, current.state, key);
    current.state = result.state;
    if (result.aside === true) {
      if (auto) toggled.current.add(model.decisionId);
      else toggled.current.delete(model.decisionId);
    }
    if (result.done !== undefined) {
      try {
        session.answer(model.decisionId, result.done.answer, result.done.summary);
        card.current = undefined;
      } catch (error) {
        failed(error);
      }
    }
    redraw();
    return true;
  };

  const onAction = (actionId: string): boolean => {
    if (session === undefined) return false;
    switch (actionId) {
      case 'chat.suggestNext':
      case 'chat.suggestPrev': {
        if (suggestions.length === 0) return false;
        const step = actionId === 'chat.suggestNext' ? 1 : -1;
        setPicked((at + step + suggestions.length) % suggestions.length);
        return true;
      }
      case 'chat.stop':
        if (!state.busy || config.chat.esc !== 'stop') return false;
        try {
          session.stop();
        } catch (error) {
          failed(error);
        }
        return true;
      case 'decision.open':
        if (!showCard || model === undefined) return false;
        if (auto) toggled.current.delete(model.decisionId);
        else toggled.current.add(model.decisionId);
        redraw();
        return true;
      default:
        return false;
    }
  };

  // ---- Drawing ----------------------------------------------------------------------------------
  const maxCard = Math.max(4, Math.floor((props.height - 6) / 2));
  const lines =
    cardFocused && model !== undefined && cardState !== undefined
      ? cardLines(model, cardState, props.width, maxCard, {
          typingPrompt: t('layout.chat.card.typing'),
          progress:
            model.total > 1 ? `${Math.min(cardState.step + 1, model.total)}/${model.total}` : '',
        })
      : [];
  const hint =
    showCard && !cardFocused
      ? clip(t('layout.chat.card.hint', { key: openKey, count: state.asks.length }), props.width)
      : undefined;
  const confirmLine =
    state.confirm === undefined
      ? undefined
      : clip(
          t('layout.chat.confirmLine', {
            command: state.confirm.command,
            prompt: state.confirm.prompt,
          }),
          props.width,
        );
  const visible = suggestions.length > 0 && !cardFocused && state.confirm === undefined;
  const inputRows =
    Math.max(1, boxRows) +
    lines.length +
    (hint === undefined ? 0 : 1) +
    (confirmLine === undefined ? 0 : 1) +
    (visible ? suggestions.length : 0);

  const input = (
    <Box flexDirection="column" width={props.width}>
      {lines.map((line, index) => (
        <Text
          key={index}
          wrap="truncate"
          bold={line.bold === true}
          dimColor={line.dim === true}
          inverse={line.inverse === true}
          {...(line.color === undefined ? {} : { color: line.color })}
        >
          {line.text === '' ? ' ' : line.text}
        </Text>
      ))}
      {hint !== undefined && (
        <Text wrap="truncate" color="yellow">
          {hint}
        </Text>
      )}
      {confirmLine !== undefined && (
        <Text wrap="truncate" color="yellow">
          {confirmLine}
        </Text>
      )}
      {visible &&
        suggestions.map((command, index) => (
          <Text key={command.id} wrap="truncate" inverse={index === at}>
            {clip(
              `${command.name}${command.args === '' ? '' : ` ${command.args}`}${
                command.description === '' ? '' : `  ${command.description}`
              }`,
              props.width,
            )}
          </Text>
        ))}
      <TextBox
        keymap={keymap.keymap}
        registry={keymap.registry}
        settings={config.input}
        history={config.history}
        onSubmit={submit}
        onChange={onChange}
        onRows={setBoxRows}
        complete={complete}
        isActive={props.active && !cardFocused && state.confirm === undefined}
      />
    </Box>
  );

  return {
    messages,
    stateParts,
    decisionFocused: cardFocused || confirmFocused,
    inputRows,
    input,
    onKey,
    onAction,
  };
}
