// SPDX-License-Identifier: MPL-2.0
import {
  deriveHelp,
  derivePalette,
  deriveShortcutBar,
  translateUiText,
  type ApiClient,
  type DaemonStores,
  type LayoutStore,
  tabContextOf,
  type UiContext,
  type UiTranslate,
} from '@otheater/client';
import { API_ROUTES } from '@otheater/protocol';
import { Box, Text, useApp, useWindowSize } from 'ink';
import { randomUUID } from 'node:crypto';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { keyLabel, pairLabel } from '../keys/labels.js';
import { useMouseCopy, type CopyOutcome, type DragInfo } from '../mouse/index.js';
import { useRawKeys, type KeyEvent, type TuiKeymap } from '../keys/use-keymap.js';
import { useRenderControl } from '../render-control.js';
import {
  DEFAULT_UI_SETTINGS,
  type UiSettings,
  type UiSetupSettings,
  type UiTuiLayoutSettings,
} from '../settings.js';
import { useStoreValue, type ReadableStore } from '../use-store-value.js';
import { useChatPanel, type ChatNewProject, type ChatPanelConfig } from '../chat/use-chat-panel.js';
import {
  SetupScreen,
  firstRunNeeded,
  setupApiOf,
  type SetupApi,
  type SetupFlow,
} from '../setup/index.js';
import { Chat, chatMessageRows } from './chat.js';
import {
  useFinishedRows,
  useLink,
  usePendingDecisions,
  useQuotaRows,
  useScenarioRows,
} from './data.js';
import { computeGeometry, steppedChatWidth } from './geometry.js';
import { Header } from './header.js';
import { initialRepo, NewProjectPrompt } from './new-project.js';
import { HelpOverlay, PaletteOverlay, TabPickerOverlay } from './overlays.js';
import { Panel, panelContentSize } from './panel.js';
import type { TabBarHit } from './tab-bar-hit.js';
import { scrollStepLines } from './scroll.js';
import {
  Sidebar,
  SIDEBAR_SECTIONS,
  sidebarItems,
  type SidebarFinished,
  type SidebarItem,
} from './sidebar.js';
import { ShortcutBar, type Hint } from './shortcut-bar.js';
import { TAB_CONTENT, type TabContentMap } from './tab-content.js';
import { useUpdateHint } from './use-update-status.js';
import { useWatched } from './use-watched.js';
import { TabHostProvider, type TabHost } from './tab-host.js';
import {
  foldedSections,
  isPanelOpen,
  saveActiveTab,
  savedActiveTab,
  setPanelOpen,
  useLayoutPreferences,
} from './use-layout.js';
import { COLOR } from './theme.js';
import { useUiTranslate } from './use-ui-translate.js';

/** The areas the focus walks, in the order Tab takes it. */
type Focus = 'chat' | 'edge' | 'panel' | 'sidebar';
type Overlay = 'palette' | 'help' | 'picker';

const FOCUS_CONTEXT: Readonly<Record<Focus, UiContext>> = {
  chat: 'chat',
  edge: 'edge',
  panel: 'panel',
  sidebar: 'sidebar',
};

/** What the overlay lets through of the global keys: the palette (to toggle it) and the way out. */
function overlayAllows(actionId: string): boolean {
  return actionId.startsWith('overlay.') || actionId === 'palette.open' || actionId === 'app.quit';
}

const TO_THE_END = Number.MAX_SAFE_INTEGER;

export interface ShellProps {
  readonly stores: DaemonStores;
  readonly layout: LayoutStore;
  readonly address: string;
  readonly tuning: UiTuiLayoutSettings;
  readonly keymap: TuiKeymap;
  /** What the chat needs to talk to the Director: the client of the daemon and the settings (P12). */
  readonly chat: ChatPanelConfig;
  /** What each tab of the panel draws; the tabs come in empty (P9) and each step fills its own. */
  readonly tabContent?: TabContentMap | undefined;
  /** [P13] The REST client and the settings the tabs read (see `tab-host.tsx`). */
  readonly client?: ApiClient | undefined;
  readonly settings?: UiSettings | undefined;
  /** The clock of the tabs (epoch ms); tests pass a fake one. */
  readonly now?: (() => number) | undefined;
  /** [P17] The routes of the setup assistant; default: the ones of `client`. Tests pass a fake. */
  readonly setupApi?: SetupApi | undefined;
  /**
   * [P17] What decides if the first run opens the assistant: `ui.setup` as the daemon says, or
   * `pending` while that is not read (the gate waits, so a `never` of the daemon is not outrun).
   * Default: `settings.setup`.
   */
  readonly setupGate?: SetupGate | undefined;
  /** [P22] The folder the TUI was opened in, where "new project" starts; default: this process's. */
  readonly cwd?: string | undefined;
}

/** `ui.setup` for the gate of the first run, or `pending` while the daemon's one is being read. */
export type SetupGate = UiSetupSettings | 'pending';

/** The screen of the TUI once the daemon answered: header, side bar, chat, panel of tabs and the bar of shortcuts. */
export function Shell(props: ShellProps): ReactNode {
  const { stores, layout: layoutStore, keymap: tuiKeymap, tuning } = props;
  const { t } = useTranslation();
  const ut = useUiTranslate();
  const { exit } = useApp();
  const { afterKey } = useRenderControl();
  const { columns, rows } = useWindowSize();
  const preferences = useLayoutPreferences(layoutStore);
  const tabContent = props.tabContent ?? TAB_CONTENT;

  const [focusState, setFocus] = useState<Focus>('chat');
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [sideCursor, setSideCursor] = useState<string | undefined>(undefined);
  const [panelCursor, setPanelCursor] = useState<string | undefined>(undefined);
  const [chatOffset, setChatOffset] = useState(0);
  const [panelScroll, setPanelScroll] = useState(0);
  const [helpOffset, setHelpOffset] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(() => firstProblem(tuiKeymap, ut));
  // A tab that reads text (a form, P15) takes the keyboard by setting this (see `TabHost.capture`).
  const capture = useRef(false);
  // The setup assistant (P17) takes the whole screen while it is open.
  const [assistant, setAssistant] = useState<SetupFlow | undefined>(undefined);
  // The prompt of "new project" (P22): what its field starts with, while it is open.
  const [newProject, setNewProject] = useState<{ readonly initial: string } | undefined>(undefined);
  const cwd = props.cwd ?? process.cwd();
  const settings = props.settings ?? DEFAULT_UI_SETTINGS;
  const setupApi = useMemo(
    () => props.setupApi ?? (props.client === undefined ? undefined : setupApiOf(props.client)),
    [props.setupApi, props.client],
  );

  const scenarioRowsNow = useScenarioRows(stores);
  const quotas = useQuotaRows(stores);
  const decisions = usePendingDecisions(stores);
  const link = useLink(stores);
  const live = link === 'live';
  const update = useUpdateHint(props.client, stores, live);
  const plays = useStoreValue(stores.plays, (s) => s.byId);
  // The "Terminadas" section (P11 of docs/19): `ui.sidebar.finishedPlays` says whether it exists
  // and how it starts; the person opens and closes it for the session.
  const finishedMode = (props.settings ?? DEFAULT_UI_SETTINGS).sidebar.finishedPlays;
  const finishedLimit = (props.settings ?? DEFAULT_UI_SETTINGS).sidebar.finishedLimit;
  const finishedRowsNow = useFinishedRows(stores, finishedLimit);
  const [finishedToggled, setFinishedToggled] = useState<boolean | undefined>(undefined);
  const finishedOpen = finishedToggled ?? finishedMode === 'expanded';
  const finished = useMemo(
    (): SidebarFinished | undefined =>
      finishedMode === 'hidden' ? undefined : { rows: finishedRowsNow, open: finishedOpen },
    [finishedMode, finishedRowsNow, finishedOpen],
  );
  // The stores read the last finished plays with their snapshot; they only need to be told how many.
  useEffect(() => {
    void stores.loadFinishedPlays(finishedMode === 'hidden' ? 0 : finishedLimit);
  }, [stores, finishedMode, finishedLimit, live]);

  const geometry = computeGeometry({
    columns,
    rows,
    sidebarCollapsed: preferences.sidebarCollapsed,
    panelOpen: isPanelOpen(preferences),
    chatWidth: preferences.chatWidth,
    tuning,
  });
  const folded = useMemo(() => foldedSections(preferences), [preferences]);

  // The focus falls back to the chat when the area it was on is not on screen.
  const order = useMemo(
    (): Focus[] => [
      'chat',
      ...(geometry.panel === undefined ? [] : (['edge', 'panel'] as const)),
      ...(geometry.sidebar.mode === 'hidden' ? [] : (['sidebar'] as const)),
    ],
    [geometry.panel, geometry.sidebar.mode],
  );
  const focus: Focus = order.includes(focusState) ? focusState : 'chat';

  // The tabs the person opened, in the order they keep.
  const registry = tuiKeymap.registry;
  const openTabs = useMemo(
    () =>
      preferences.openTabs
        .map((id) => registry.tabs.find((tab) => tab.id === id))
        .filter((tab) => tab !== undefined)
        .map((tab) => ({ id: tab.id, label: t(tab.textKey) })),
    [preferences.openTabs, registry, t],
  );
  const activeTab = savedActiveTab(preferences);
  const currentTab = openTabs.some((tab) => tab.id === activeTab) ? activeTab : openTabs[0]?.id;
  const definition = currentTab === undefined ? undefined : tabContent[currentTab];
  const watched = useMemo(() => definition?.watch?.(stores) ?? NO_STORES, [definition, stores]);
  const watchVersion = useWatched(watched);

  // The scenario the chat is about, and what the header says of it.
  const selectedRow = scenarioRowsNow.find((row) => row.id === selected) ?? scenarioRowsNow[0];
  const tabSettings = props.settings ?? DEFAULT_UI_SETTINGS;
  const tabSections = useMemo(
    () => {
      const sections = definition?.sections;
      if (sections === undefined) return NO_SECTIONS;
      return typeof sections === 'function'
        ? sections({ stores, scenarioId: selectedRow?.id, settings: tabSettings }, folded)
        : sections;
    },
    // `watchVersion` changes when a store the tab named changes: the list is asked again.
    [definition, stores, selectedRow?.id, tabSettings, folded, watchVersion],
  );
  const cursorInTab =
    panelCursor !== undefined && tabSections.includes(panelCursor) ? panelCursor : tabSections[0];
  const play = useMemo(() => {
    if (selectedRow === undefined) return undefined;
    let found: { need: string; updatedAt: number } | undefined;
    for (const candidate of Object.values(plays)) {
      if (candidate.scenarioId !== selectedRow.id || candidate.finishedAt !== null) continue;
      if (found === undefined || candidate.updatedAt > found.updatedAt) found = candidate;
    }
    return found?.need;
  }, [plays, selectedRow]);

  const items = useMemo(
    () =>
      sidebarItems(
        scenarioRowsNow,
        folded,
        geometry.sidebar.mode === 'rail' ? 'rail' : 'expanded',
        finished,
      ),
    [scenarioRowsNow, folded, geometry.sidebar.mode, finished],
  );
  const cursorInSide = items.some((item) => item.id === sideCursor) ? sideCursor : items[0]?.id;

  // "New project" (P22): the same opening as `ot chat --type project --repo .`, and the screen goes to it.
  const selectScenario = useCallback((id: string): void => {
    setSelected(id);
    setChatOffset(0);
    setFocus('chat');
  }, []);
  const projectRepo = settings.newProject.repo;
  const chatNewProject = useMemo(
    (): ChatNewProject => ({
      cwd,
      prompt: () => {
        setNewProject({ initial: initialRepo(projectRepo, cwd) });
      },
      opened: selectScenario,
    }),
    [cwd, projectRepo, selectScenario],
  );
  const projectClient = props.client ?? props.chat.client;
  const openProject = useCallback(
    async (repo: string): Promise<void> => {
      if (projectClient === undefined) throw new Error(t('layout.newProject.noConnection'));
      const opened = await projectClient.call(API_ROUTES.openScenario, {
        body: { type: 'project', repo },
        headers: { 'idempotency-key': randomUUID() },
      });
      selectScenario(opened.scenario.id);
      setNotice(t('layout.newProject.opened', { name: opened.scenario.name }));
    },
    [projectClient, selectScenario, t],
  );

  const chat = useChatPanel({
    stores,
    config: props.chat,
    scenarioId: selectedRow?.id,
    keymap: tuiKeymap,
    width: Math.max(1, geometry.chat.width - 2),
    height: geometry.bodyHeight,
    active:
      focus === 'chat' &&
      overlay === undefined &&
      assistant === undefined &&
      newProject === undefined,
    newProject: chatNewProject,
  });
  const messageRows = chatMessageRows(geometry.bodyHeight, chat.inputRows);
  const step = scrollStepLines(tuning.scrollStep, messageRows);

  const quit = useCallback((): void => {
    layoutStore
      .flush()
      .catch(() => undefined)
      .finally(() => {
        exit();
      });
  }, [layoutStore, exit]);

  // The first run (N121, N195): the daemon says there is no configuration, and the TUI opens straight
  // in the assistant. [proposta] The read is not waited for: the layout is drawn at once and the
  // assistant takes over when the answer says so; what cannot be read is said in the notice.
  const firstRunChecked = useRef(false);
  const onGateFailed = useEffectEvent((message: string): void => {
    setNotice(t('setup.gateFailed', { message }));
  });
  const gate = props.setupGate ?? settings.setup;
  const gateOpen = gate === 'pending' ? undefined : gate.open;
  const gateTimeoutMs = gate === 'pending' ? undefined : gate.readTimeoutMs;
  useEffect(() => {
    if (firstRunChecked.current || setupApi === undefined) return;
    if (gateOpen !== 'auto' || gateTimeoutMs === undefined) return;
    firstRunChecked.current = true;
    let mounted = true;
    firstRunNeeded(setupApi, gateTimeoutMs)
      .then((needed) => {
        if (needed && mounted) setAssistant('first_run');
      })
      .catch((error: unknown) => {
        if (mounted) onGateFailed(error instanceof Error ? error.message : String(error));
      });
    return () => {
      mounted = false;
    };
  }, [setupApi, gateOpen, gateTimeoutMs]);

  // Whatever way the TUI ends (Ctrl+Q, Ctrl+C, the terminal going away), the layout is saved.
  useEffect(
    () => () => {
      layoutStore.flush().catch(() => undefined);
    },
    [layoutStore],
  );

  const showPanel = useCallback(
    (tab: string): void => {
      layoutStore.openTab(tab);
      setPanelOpen(layoutStore, true);
      saveActiveTab(layoutStore, tab);
      setPanelScroll(0);
    },
    [layoutStore],
  );

  const moveFocus = (delta: 1 | -1): void => {
    const at = order.indexOf(focus);
    setFocus(order[(at + delta + order.length) % order.length] ?? 'chat');
  };

  const widenTo = (width: number): void => {
    if (geometry.panel === undefined) return;
    layoutStore.setChatWidth(width);
  };

  const widen = (cells: number): void => {
    if (geometry.panel === undefined) return;
    // From the width the store has now: two presses in the same tick (key repeat) both count.
    layoutStore.setChatWidth(steppedChatWidth(geometry, cells, layoutStore.layout.chatWidth));
  };

  const walk = <T extends string>(
    list: readonly T[],
    from: T | undefined,
    delta: number,
  ): T | undefined => {
    if (list.length === 0) return undefined;
    const at = from === undefined ? 0 : Math.max(0, list.indexOf(from));
    return list[Math.min(list.length - 1, Math.max(0, at + delta))];
  };

  // What the mouse does (N34): the same actions as the keys, reached by a click, the wheel or a drag.
  const closeTab = (id: string): void => {
    const at = openTabs.findIndex((tab) => tab.id === id);
    if (at < 0) return;
    const next =
      id === currentTab
        ? (openTabs[at + 1] ?? openTabs[at - 1])
        : openTabs.find((tab) => tab.id === currentTab);
    layoutStore.closeTab(id);
    saveActiveTab(layoutStore, next?.id);
    setPanelScroll(0);
    setPanelCursor(undefined);
  };

  const activateSideItem = (item: SidebarItem): void => {
    if (item.kind === 'section') {
      if (item.id === SIDEBAR_SECTIONS.finished) setFinishedToggled(!finishedOpen);
      else layoutStore.setSectionCollapsed(item.id);
    } else if (item.kind === 'finished') {
      // A finished play has no screen of its own: the chat goes to the scenario it belongs to.
      if (item.scenarioId !== undefined) selectScenario(item.scenarioId);
    } else {
      setSelected(item.id);
      setChatOffset(0);
      setFocus('chat');
    }
  };

  const chatDragFrom = useRef(0);
  const dragChatEdge = (drag: DragInfo): void => {
    if (drag.phase === 'start') {
      chatDragFrom.current = geometry.chat.width;
      setFocus('edge');
      return;
    }
    widenTo(steppedChatWidth(geometry, drag.dx, chatDragFrom.current));
  };

  const copyNotice = useCallback(
    (outcome: CopyOutcome): void => {
      if (outcome.ok) {
        setNotice(t('layout.mouse.copied', { chars: outcome.chars }));
      } else if (outcome.reason !== 'empty') {
        setNotice(t(`layout.mouse.copyFailed.${outcome.reason}`));
      }
    },
    [t],
  );
  useMouseCopy(copyNotice);

  const runAction = (id: string): void => {
    if (id.startsWith('tabs.open.')) {
      const tab = id.slice('tabs.open.'.length);
      if (registry.tabs.some((candidate) => candidate.id === tab)) {
        showPanel(tab);
        setFocus('panel');
      }
      return;
    }
    switch (id) {
      case 'app.quit':
        quit();
        return;
      case 'layout.toggleSidebar':
        layoutStore.setSidebarCollapsed(!preferences.sidebarCollapsed);
        return;
      case 'layout.togglePanel':
        setPanelOpen(layoutStore, !isPanelOpen(preferences));
        return;
      case 'layout.narrowChat':
      case 'edge.narrow':
        widen(-tuning.chatStep);
        return;
      case 'layout.widenChat':
      case 'edge.widen':
        widen(tuning.chatStep);
        return;
      case 'layout.focusNext':
        moveFocus(1);
        return;
      case 'layout.focusPrev':
        moveFocus(-1);
        return;
      case 'tabs.add':
        setOverlay('picker');
        return;
      case 'tabs.close':
        if (currentTab !== undefined) closeTab(currentTab);
        return;
      case 'palette.open':
        setOverlay((now) => (now === 'palette' ? undefined : 'palette'));
        return;
      case 'help.show':
        setHelpOffset(0);
        setOverlay('help');
        return;
      case 'overlay.close':
        setOverlay(undefined);
        return;
      case 'overlay.pageUp':
        setHelpOffset((offset) => Math.max(0, offset - step));
        return;
      case 'overlay.pageDown':
        setHelpOffset((offset) => offset + step);
        return;
      case 'chat.scrollUp':
        setChatOffset((offset) => offset + step);
        return;
      case 'chat.scrollDown':
        setChatOffset((offset) => Math.max(0, offset - step));
        return;
      case 'chat.scrollTop':
        setChatOffset(TO_THE_END);
        return;
      case 'chat.scrollBottom':
        setChatOffset(0);
        return;
      case 'sidebar.up':
      case 'sidebar.down': {
        const ids = items.map((item) => item.id);
        setSideCursor(walk(ids, cursorInSide, id === 'sidebar.up' ? -1 : 1));
        return;
      }
      case 'sidebar.toggleFinished':
        if (finished !== undefined) setFinishedToggled(!finishedOpen);
        return;
      case 'sidebar.newProject':
        setNewProject({ initial: initialRepo(projectRepo, cwd) });
        return;
      case 'sidebar.activate': {
        const item = items.find((candidate) => candidate.id === cursorInSide);
        if (item !== undefined) activateSideItem(item);
        return;
      }
      case 'panel.prevTab':
      case 'panel.nextTab': {
        const ids = openTabs.map((tab) => tab.id);
        saveActiveTab(layoutStore, walk(ids, currentTab, id === 'panel.prevTab' ? -1 : 1));
        setPanelScroll(0);
        setPanelCursor(undefined);
        return;
      }
      case 'panel.up':
      case 'panel.down':
        setPanelCursor(walk(tabSections, cursorInTab, id === 'panel.up' ? -1 : 1));
        return;
      case 'panel.pageUp':
        setPanelScroll((offset) => Math.max(0, offset - step));
        return;
      case 'panel.pageDown':
        setPanelScroll((offset) => offset + step);
        return;
      case 'panel.activate':
        if (cursorInTab !== undefined) layoutStore.setSectionCollapsed(cursorInTab);
        return;
      default:
        return;
    }
  };

  const clickTabBar = (hit: TabBarHit): void => {
    switch (hit.kind) {
      case 'tab':
        saveActiveTab(layoutStore, hit.id);
        setPanelScroll(0);
        setPanelCursor(undefined);
        setFocus('panel');
        return;
      case 'close':
        closeTab(hit.id);
        return;
      case 'add':
        runAction('tabs.add');
        return;
      case 'toggle':
        runAction('layout.togglePanel');
        return;
    }
  };

  useRawKeys((event: KeyEvent) => {
    if (notice !== undefined) setNotice(undefined);
    if (event.data === '\x03') {
      quit();
      return;
    }
    if (capture.current || assistant !== undefined) {
      afterKey();
      return;
    }
    // The decision card and the confirmation of a command answer first (P12).
    const inChat = overlay === undefined && focus === 'chat';
    if (inChat && chat.onKey(event)) {
      afterKey();
      return;
    }
    if (event.combo !== undefined) {
      const contexts: UiContext[] =
        overlay === undefined
          ? [
              'global',
              ...(inChat && chat.decisionFocused
                ? (['decision', 'chat'] as const)
                : [FOCUS_CONTEXT[focus]]),
            ]
          : ['overlay', 'global'];
      const id = tuiKeymap.match(event.combo, contexts);
      if (id !== undefined && (overlay === undefined || overlayAllows(id))) {
        if (!inChat || !chat.onAction(id)) runAction(id);
      }
    }
    afterKey();
  });

  const contexts: UiContext[] =
    overlay === undefined
      ? ['global', focus === 'chat' && chat.decisionFocused ? 'decision' : FOCUS_CONTEXT[focus]]
      : ['overlay'];
  const barItems = deriveShortcutBar(registry, tuiKeymap.keymap, contexts);
  // The panel's keys and those of the open tab (each tab has a context of its own).
  const panelTabContext = tabContextOf(currentTab);
  const panelFooter = useMemo(
    (): Hint[] =>
      deriveShortcutBar(
        registry,
        tuiKeymap.keymap,
        panelTabContext === undefined ? ['panel'] : ['panel', panelTabContext],
      ).map((item) => ({
        id: item.id,
        label: item.label,
        text: translateUiText(ut, item.text),
      })),
    [registry, tuiKeymap, ut, panelTabContext],
  );
  const paletteRows = useMemo(
    () => derivePalette(registry, tuiKeymap.keymap),
    [registry, tuiKeymap],
  );
  const helpGroups = useMemo(() => deriveHelp(registry, tuiKeymap.keymap), [registry, tuiKeymap]);
  const closeKey = keyLabel(tuiKeymap, 'overlay.close') ?? '';
  const closeHint = t('layout.overlay.closeHint', { key: closeKey });
  const pickerChoices = registry.tabs
    .filter((tab) => !preferences.openTabs.includes(tab.id))
    .map((tab) => ({ id: tab.id, label: t(tab.textKey) }));

  const screen = { columns: geometry.columns, rows: geometry.rows };
  const height = geometry.bodyHeight;
  const resizable = geometry.panel !== undefined;
  const resizeKeys = pairLabel(
    keyLabel(tuiKeymap, 'layout.narrowChat'),
    keyLabel(tuiKeymap, 'layout.widenChat'),
  );
  const tabHost = useMemo(
    (): TabHost => ({
      stores,
      client: props.client,
      keymap: tuiKeymap,
      settings,
      now: props.now ?? Date.now,
      capture,
      openAssistant: setupApi === undefined ? undefined : setAssistant,
    }),
    [stores, props.client, tuiKeymap, settings, props.now, setupApi],
  );
  const content =
    geometry.panel === undefined ? undefined : panelContentSize(geometry.panel.width, height);

  if (assistant !== undefined && setupApi !== undefined) {
    return (
      <SetupScreen
        flow={assistant}
        api={setupApi}
        keymap={tuiKeymap}
        onClose={() => {
          setAssistant(undefined);
        }}
      />
    );
  }

  return (
    <TabHostProvider host={tabHost}>
      <Box flexDirection="column" width={geometry.columns} height={geometry.rows}>
        <Header
          width={geometry.columns}
          scenarioName={selectedRow?.name}
          play={play}
          mark={selectedRow?.mark}
          decisions={decisions}
          address={props.address}
          link={link}
          update={update}
        />
        <Box height={height}>
          {geometry.sidebar.mode !== 'hidden' && (
            <Sidebar
              mode={geometry.sidebar.mode}
              width={geometry.sidebar.width}
              height={height}
              focused={focus === 'sidebar'}
              rows={scenarioRowsNow}
              finished={finished}
              quotas={quotas}
              folded={folded}
              selectedId={selectedRow?.id}
              cursor={cursorInSide}
              address={props.address}
              live={live}
              keys={{
                toggle: keyLabel(tuiKeymap, 'layout.toggleSidebar'),
                settings: keyLabel(tuiKeymap, 'tabs.open.settings'),
              }}
              onActivate={(item) => {
                setSideCursor(item.id);
                activateSideItem(item);
                if (item.kind === 'section') setFocus('sidebar');
              }}
              onSettings={() => {
                runAction('tabs.open.settings');
              }}
              onToggle={() => {
                runAction('layout.toggleSidebar');
              }}
              onNewProject={() => {
                runAction('sidebar.newProject');
              }}
            />
          )}
          <Chat
            width={geometry.chat.width}
            height={height}
            focused={focus === 'chat'}
            edgeFocused={focus === 'edge'}
            resizable={resizable}
            widthLabel={
              resizable
                ? t('layout.chat.widthLabel', {
                    cols: geometry.chat.width,
                    keys: resizeKeys,
                  })
                : undefined
            }
            title={selectedRow?.name ?? t('layout.header.noScenario')}
            stateLine={
              selectedRow === undefined
                ? ''
                : [
                    t('layout.chat.state', { state: t(`layout.state.${selectedRow.mark}`) }),
                    ...chat.stateParts,
                  ].join(' · ')
            }
            messages={chat.messages}
            offset={chatOffset}
            onOffset={setChatOffset}
            onResizeDrag={dragChatEdge}
            input={chat.input}
            inputRows={chat.inputRows}
          />
          {geometry.panel !== undefined && content !== undefined && (
            <Panel
              width={geometry.panel.width}
              height={height}
              focused={focus === 'panel'}
              tabs={openTabs}
              active={currentTab}
              keys={{
                add: keyLabel(tuiKeymap, 'tabs.add'),
                toggle: keyLabel(tuiKeymap, 'layout.togglePanel'),
              }}
              footer={panelFooter}
              onBarClick={clickTabBar}
              onWheel={(lines) => {
                setPanelScroll((offset) => Math.max(0, offset + lines));
              }}
            >
              {definition === undefined ? (
                <Text dimColor wrap="truncate">
                  {openTabs.length === 0 ? t('layout.panel.noTabs') : t('layout.panel.empty')}
                </Text>
              ) : (
                <Box
                  marginTop={-panelScroll}
                  flexShrink={0}
                  flexDirection="column"
                  width={content.width}
                >
                  {definition.render({
                    width: content.width,
                    height: content.height,
                    focused: focus === 'panel' && overlay === undefined,
                    scroll: panelScroll,
                    scenarioId: selectedRow?.id,
                    sections: {
                      folded,
                      cursor: focus === 'panel' ? cursorInTab : undefined,
                      toggle: (id) => {
                        layoutStore.setSectionCollapsed(id);
                        setPanelCursor(id);
                        setFocus('panel');
                      },
                    },
                  })}
                </Box>
              )}
            </Panel>
          )}
        </Box>
        {notice === undefined ? (
          <ShortcutBar width={geometry.columns} items={barItems} />
        ) : (
          <Text color={COLOR.warn} wrap="truncate">
            {` ${notice}`}
          </Text>
        )}
        {overlay === 'palette' && (
          <PaletteOverlay
            screen={screen}
            rows={paletteRows}
            hint={closeHint}
            onRun={(id) => {
              setOverlay(undefined);
              if (!chat.onAction(id)) runAction(id);
            }}
          />
        )}
        {overlay === 'help' && (
          <HelpOverlay
            screen={screen}
            groups={helpGroups}
            offset={helpOffset}
            onOffset={setHelpOffset}
            hint={closeHint}
          />
        )}
        {overlay === 'picker' && (
          <TabPickerOverlay
            screen={screen}
            choices={pickerChoices}
            hint={closeHint}
            onPick={(id) => {
              setOverlay(undefined);
              showPanel(id);
            }}
          />
        )}
        {newProject !== undefined && (
          <NewProjectPrompt
            screen={screen}
            initial={newProject.initial}
            cwd={cwd}
            open={openProject}
            capture={capture}
            onClose={() => {
              setNewProject(undefined);
            }}
          />
        )}
      </Box>
    </TabHostProvider>
  );
}

const NO_SECTIONS: readonly string[] = [];
const NO_STORES: readonly ReadableStore<unknown>[] = [];

/** The first thing wrong with the keymap, or the first notice, in the person's language. */
function firstProblem(keymap: TuiKeymap, t: UiTranslate): string | undefined {
  const error = keymap.errors[0];
  if (error !== undefined) return translateUiText(t, error.text);
  const warning = keymap.warnings[0];
  return warning === undefined ? undefined : translateUiText(t, warning.text);
}
