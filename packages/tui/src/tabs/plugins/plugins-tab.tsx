// SPDX-License-Identifier: MPL-2.0
import type { ApiPlugin, ApiPluginDetail, ApiPluginPanel } from '@otheater/protocol';
import { Box } from 'ink';
import {
  createElement,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../../layout/themed-text.js';
import { keyLabel } from '../../keys/labels.js';
import { useRawKeys, type KeyEvent } from '../../keys/use-keymap.js';
import { Section } from '../../layout/section.js';
import { useTabHost } from '../../layout/tab-host.js';
import type { TabContentProps } from '../../layout/tab-types.js';
import { fit, wrapText } from '../../layout/text.js';
import { TOKEN, paint } from '../../layout/theme.js';
import { useRenderControl } from '../../render-control.js';
import { errorText } from '../settings/settings-tab.js';
import { apiOf, type PluginsApi } from './api.js';
import {
  SECTION_IDS,
  actionResultLines,
  activationRows,
  missingSecretsOf,
  panelView,
  safeText,
  secretCommand,
  secretRows,
  stateOf,
  type PanelTone,
  type PluginViewState,
  type Translate,
} from './model.js';

/**
 * The tab Plugins (§5.13 and 5.14; P11 of Phase 9): the plugins installed, what the selected one
 * asks for before it is turned on, the command to turn it on or off in the project selected in the
 * side bar, the secrets it lacks and the panel its manifest declares, drawn from data (blocks of a
 * table, a list, metrics and an action). No code of a plugin runs here: the daemon calls the tools
 * and sends the rows, and an action goes back to the daemon, which asks the Producer first when the
 * tool needs it. [proposta] There is no route that writes a secret (P10 made none), so the tab
 * shows the names that are missing and the command `ot plugin secret set`, and never a value.
 */

export interface PluginsTabDefinition {
  readonly sections: readonly string[];
  readonly render: (props: TabContentProps) => ReactNode;
}

export interface PluginsTabOptions {
  /** The routes of the tab; default: the client of the daemon the TUI is connected to. */
  readonly api?: PluginsApi | undefined;
}

type Tone = 'ok' | 'warn' | 'error';

interface Message {
  readonly lines: readonly { readonly tone: Tone; readonly text: string }[];
}

/** What the tab shows about the selected plugin; `pluginId` and `project` say which it was read for. */
interface View {
  readonly pluginId: string;
  readonly project: string | undefined;
  readonly detail?: ApiPluginDetail | undefined;
  readonly detailError?: string | undefined;
  readonly panel?: ApiPluginPanel | undefined;
  readonly panelError?: string | undefined;
}

type Mode =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'enable';
      readonly plugin: ApiPlugin;
      readonly project: string;
      readonly projectName: string;
      readonly detail: ApiPluginDetail;
      readonly again: boolean;
    }
  | {
      readonly kind: 'disable';
      readonly plugin: ApiPlugin;
      readonly project: string;
      readonly projectName: string;
    };

const IDLE: Mode = { kind: 'idle' };

const TONE_COLOR: Readonly<Record<Tone, string>> = {
  ok: TOKEN.ok,
  warn: TOKEN.warn,
  error: TOKEN.error,
};

const STATE_COLOR: Readonly<Record<PluginViewState, string | undefined>> = {
  active: TOKEN.ok,
  needs_approval: TOKEN.warn,
  broken: TOKEN.error,
  off: undefined,
};

const PANEL_COLOR: Readonly<Record<PanelTone, string | undefined>> = {
  title: TOKEN.accent,
  head: undefined,
  text: undefined,
  dim: undefined,
  warn: TOKEN.warn,
  error: TOKEN.error,
  action: undefined,
};

interface Line {
  readonly key: string;
  readonly kind: 'header' | 'row';
  readonly section?: string;
  readonly title?: string;
  readonly right?: string | undefined;
  readonly text?: string;
  readonly color?: string | undefined;
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly selected?: boolean;
  /** Rows that follow the text of the line at this indent are wrapped with it kept. */
  readonly indent?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The key of a plugin in a project, for what events say about the pair. */
function pairKey(plugin: string, project: string | undefined): string {
  return `${plugin}\u0000${project ?? ''}`;
}

/** Wait of the tab before it reads what an event said changed, so a burst of events is one read. */
const RELOAD_MS = 30;
/** Wait after the cursor moved before the detail and the panel of the new plugin are asked for. */
const SELECT_MS = 40;

interface TabProps {
  readonly content: TabContentProps;
  readonly options: PluginsTabOptions;
}

function PluginsTab({ content, options }: TabProps): ReactNode {
  const { t, i18n } = useTranslation();
  const { stores, keymap, capture } = useTabHost();
  const { afterKey } = useRenderControl();
  const scenarioId = content.scenarioId;
  const api = useMemo(() => options.api ?? apiOf(stores.client), [options.api, stores]);
  const language = i18n.language;
  const tr = t as unknown as Translate;

  const [plugins, setPlugins] = useState<readonly ApiPlugin[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [view, setView] = useState<View | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [mode, setModeState] = useState<Mode>(IDLE);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [running, setRunning] = useState<{ label: string; approval: string } | undefined>(
    undefined,
  );
  const [missing, setMissing] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [failed, setFailed] = useState<Readonly<Record<string, boolean>>>({});
  const modeRef = useRef<Mode>(IDLE);
  const mounted = useRef(true);
  const busy = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (reloadTimer.current !== undefined) clearTimeout(reloadTimer.current);
      capture.current = false;
    };
  }, [capture]);

  const setMode = useCallback(
    (next: Mode): void => {
      modeRef.current = next;
      setModeState(next);
      if (next.kind !== 'idle') {
        capture.current = true;
      } else {
        // The Shell saw the key that closed the card; it must not act as a command of the panel too.
        queueMicrotask(() => {
          if (modeRef.current.kind === 'idle') capture.current = false;
        });
      }
    },
    [capture],
  );

  const say = useCallback((text: string, tone: Tone): void => {
    if (mounted.current) setMessage({ lines: [{ tone, text }] });
  }, []);

  const failure = useCallback(
    (error: unknown): void => {
      say(t('plugins.result.failed', { message: safeText(errorText(error)) }), 'error');
    },
    [say, t],
  );

  const reloadList = useCallback(async (): Promise<void> => {
    try {
      const list = await api.list();
      if (!mounted.current) return;
      setPlugins(list);
      setLoadError(undefined);
    } catch (error) {
      if (mounted.current) setLoadError(safeText(errorText(error)));
    }
  }, [api]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  const reloadSoon = useCallback(
    (list: boolean): void => {
      if (reloadTimer.current !== undefined) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = undefined;
        if (list) void reloadList();
        setTick((value) => value + 1);
      }, RELOAD_MS);
    },
    [reloadList],
  );

  const selected: ApiPlugin | undefined =
    plugins === undefined ? undefined : plugins[Math.min(cursor, plugins.length - 1)];
  const selectedId = selected?.id;
  const selectedState: PluginViewState | undefined =
    selected === undefined ? undefined : stateOf(selected, scenarioId);

  // The detail and the panel of the selected plugin, asked for again when the selection, the
  // project, its state or an event changes them. A late answer for another selection is dropped.
  useEffect(() => {
    if (selectedId === undefined) {
      setView(undefined);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        let next: View = { pluginId: selectedId, project: scenarioId };
        try {
          next = { ...next, detail: await api.detail(selectedId, language) };
        } catch (error) {
          next = { ...next, detailError: safeText(errorText(error)) };
        }
        if (selectedState === 'active' && scenarioId !== undefined) {
          try {
            next = { ...next, panel: await api.panel(selectedId, scenarioId, language) };
          } catch (error) {
            next = { ...next, panelError: safeText(errorText(error)) };
          }
        }
        if (!cancelled && mounted.current) setView(next);
      })();
    }, SELECT_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, selectedId, selectedState, scenarioId, language, tick]);

  // What the events say: the set of plugins changed, a secret is missing, a server failed, or a
  // plugin of its own published something (the panel may have changed).
  const lastEvent = useRef(
    stores.events.getState().events.reduce((top, event) => Math.max(top, event.id), 0),
  );
  const onEvent = useEffectEvent((type: string, payload: Record<string, unknown>): void => {
    if (!type.startsWith('plugin.')) return;
    const parts = type.split('.');
    const plugin = typeof payload.plugin === 'string' ? payload.plugin : undefined;
    const project = typeof payload.project === 'string' ? payload.project : undefined;
    if (type === 'plugin.secret_missing') {
      const found = missingSecretsOf(payload);
      if (found !== undefined) {
        setMissing((now) => ({ ...now, [pairKey(found.plugin, found.project)]: found.secrets }));
      }
      return;
    }
    if (type === 'plugin.server_failed') {
      if (plugin !== undefined) setFailed((now) => ({ ...now, [pairKey(plugin, project)]: true }));
      return;
    }
    if (type === 'plugin.server_started' && plugin !== undefined) {
      const pair = pairKey(plugin, project);
      setFailed((now) => ({ ...now, [pair]: false }));
      setMissing((now) => ({ ...now, [pair]: [] }));
      return;
    }
    if (
      type === 'plugin.installed' ||
      type === 'plugin.removed' ||
      type === 'plugin.enabled' ||
      type === 'plugin.disabled'
    ) {
      reloadSoon(true);
      return;
    }
    // `plugin.<id>.<name>`: an event of the plugin itself; its panel may show it.
    if (parts.length === 3 && parts[1] === selectedId) reloadSoon(false);
  });
  useEffect(
    () =>
      stores.events.subscribe((state) => {
        for (const event of state.events) {
          if (event.id <= lastEvent.current) continue;
          lastEvent.current = event.id;
          onEvent(event.type, isRecord(event.payload) ? event.payload : {});
        }
      }),
    [stores],
  );

  const shown: View | undefined =
    view !== undefined && view.pluginId === selectedId && view.project === scenarioId
      ? view
      : undefined;
  const panel = useMemo(
    () => (shown?.panel === undefined ? undefined : panelView(shown.panel, content.width - 2, tr)),
    [shown?.panel, content.width, tr],
  );
  const actionCount = panel?.actions.length ?? 0;
  const pickedAction = actionCount === 0 ? undefined : panel?.actions[actionIndex % actionCount];

  const projectName = (project: string): string =>
    stores.scenarios.getState().byId[project]?.name ?? project;

  // ---- Commands ----

  const run = (job: () => Promise<void>): void => {
    if (busy.current) return;
    busy.current = true;
    void job()
      .catch((error: unknown) => {
        failure(error);
      })
      .finally(() => {
        busy.current = false;
      });
  };

  const openEnable = (): void => {
    if (selected === undefined) return;
    if (scenarioId === undefined) {
      say(t('plugins.result.noProject'), 'warn');
      return;
    }
    const state = stateOf(selected, scenarioId);
    if (state === 'broken') {
      say(t('plugins.result.broken', { plugin: selected.id }), 'warn');
      return;
    }
    if (state === 'active') {
      say(t('plugins.result.alreadyOn', { plugin: selected.id }), 'warn');
      return;
    }
    const plugin = selected;
    run(async () => {
      const detail = await api.detail(plugin.id, language);
      if (!mounted.current) return;
      setMode({
        kind: 'enable',
        plugin,
        project: scenarioId,
        projectName: projectName(scenarioId),
        detail,
        again: state === 'needs_approval',
      });
    });
  };

  const openDisable = (): void => {
    if (selected === undefined) return;
    if (scenarioId === undefined) {
      say(t('plugins.result.noProject'), 'warn');
      return;
    }
    if (stateOf(selected, scenarioId) === 'off' || selected.problem !== null) {
      say(t('plugins.result.notOn', { plugin: selected.id }), 'warn');
      return;
    }
    setMode({
      kind: 'disable',
      plugin: selected,
      project: scenarioId,
      projectName: projectName(scenarioId),
    });
  };

  const confirm = (current: Exclude<Mode, { kind: 'idle' }>): void => {
    setMode(IDLE);
    if (current.kind === 'enable') {
      run(async () => {
        const result = await api.enable(
          current.plugin.id,
          current.project,
          current.detail.currentManifestHash,
        );
        say(
          t(result.changed ? 'plugins.result.enabled' : 'plugins.result.enabledSame', {
            plugin: current.plugin.id,
            project: current.projectName,
          }),
          'ok',
        );
        await reloadList();
        setTick((value) => value + 1);
      });
      return;
    }
    run(async () => {
      const result = await api.disable(current.plugin.id, current.project);
      say(
        t(result.disabled ? 'plugins.result.disabled' : 'plugins.result.disabledSame', {
          plugin: current.plugin.id,
          project: current.projectName,
        }),
        'ok',
      );
      await reloadList();
      setTick((value) => value + 1);
    });
  };

  const runAction = (): void => {
    if (selected === undefined || scenarioId === undefined) return;
    if (pickedAction === undefined) {
      say(t('plugins.result.noAction'), 'warn');
      return;
    }
    const action = pickedAction;
    const plugin = selected;
    const project = scenarioId;
    run(async () => {
      setRunning({ label: action.label, approval: action.approval });
      try {
        const result = await api.action(plugin.id, action.tool, project);
        if (!mounted.current) return;
        setMessage({ lines: actionResultLines(action.label, result, tr) });
        // What the action changed shows in the panel.
        setTick((value) => value + 1);
      } finally {
        if (mounted.current) setRunning(undefined);
      }
    });
  };

  const move = (delta: -1 | 1): void => {
    const last = Math.max(0, (plugins?.length ?? 0) - 1);
    setCursor((now) => Math.min(last, Math.max(0, Math.min(now, last) + delta)));
    setActionIndex(0);
  };

  const handleIdle = (event: KeyEvent): void => {
    if (event.combo === undefined) return;
    const action = keymap.match(event.combo, ['plugins']);
    if (!action?.startsWith('plugins.')) return;
    if (message !== undefined) setMessage(undefined);
    switch (action.slice('plugins.'.length)) {
      case 'itemPrev':
        move(-1);
        break;
      case 'itemNext':
        move(1);
        break;
      case 'enable':
        openEnable();
        break;
      case 'disable':
        openDisable();
        break;
      case 'actionNext':
        if (actionCount > 0) setActionIndex((now) => (now + 1) % actionCount);
        break;
      case 'action':
        runAction();
        break;
      case 'reload':
        void reloadList();
        setTick((value) => value + 1);
        break;
      default:
        break;
    }
  };

  const handleMode = (event: KeyEvent, current: Exclude<Mode, { kind: 'idle' }>): void => {
    if (current.kind === 'enable') {
      if (event.combo === 'Enter') confirm(current);
      else if (event.combo === 'Esc') setMode(IDLE);
      return;
    }
    // The question of a turn off: `y` confirms, any other key cancels (the rule of the tab Settings).
    const yes = t('plugins.prompt.yes').toUpperCase();
    if ((event.combo ?? '').toUpperCase() === yes) confirm(current);
    else setMode(IDLE);
  };

  useRawKeys(
    (event) => {
      const current = modeRef.current;
      if (current.kind === 'idle') handleIdle(event);
      else handleMode(event, current);
      afterKey();
    },
    { isActive: content.focused || mode.kind !== 'idle' },
  );

  // ---- What it draws ----

  const width = content.width;
  const lines: Line[] = [];
  const head: Line[] = [];

  const keyOf = (id: string): string => keyLabel(keymap, `plugins.${id}`) ?? '';
  head.push({
    key: 'scope',
    kind: 'row',
    dim: true,
    text:
      scenarioId === undefined
        ? t('plugins.scope.none')
        : t('plugins.scope.project', { name: projectName(scenarioId) }),
  });
  if (mode.kind === 'enable') {
    head.push({
      key: 'e.q',
      kind: 'row',
      color: TOKEN.accent,
      text: t(mode.again ? 'plugins.enable.again' : 'plugins.enable.question', {
        plugin: mode.plugin.id,
        version: mode.detail.version,
        project: mode.projectName,
      }),
    });
    for (const [index, text] of activationRows(mode.detail, width - 3).entries()) {
      head.push({ key: `e.a${String(index)}`, kind: 'row', text: `  ${text}` });
    }
    head.push({ key: 'e.hint', kind: 'row', dim: true, text: t('plugins.enable.hint') });
  } else if (mode.kind === 'disable') {
    head.push({
      key: 'd.q',
      kind: 'row',
      color: TOKEN.warn,
      text: t('plugins.disable.question', { plugin: mode.plugin.id, project: mode.projectName }),
    });
    head.push({ key: 'd.hint', kind: 'row', dim: true, text: t('plugins.disable.hint') });
  }
  if (running !== undefined) {
    head.push({
      key: 'run',
      kind: 'row',
      color: TOKEN.accent,
      text:
        running.approval === 'none'
          ? t('plugins.action.running', { action: running.label })
          : t('plugins.action.waiting', { action: running.label }),
    });
  }
  if (message !== undefined) {
    message.lines.forEach((line, index) => {
      head.push({
        key: `m${String(index)}`,
        kind: 'row',
        color: TONE_COLOR[line.tone],
        text: line.text,
      });
    });
  }
  if (plugins === undefined) {
    head.push({
      key: 'load',
      kind: 'row',
      dim: loadError === undefined,
      color: loadError === undefined ? undefined : TOKEN.error,
      text:
        loadError === undefined
          ? t('plugins.loading')
          : t('plugins.loadFailed', { message: loadError }),
    });
  }

  if (plugins !== undefined) {
    lines.push({
      key: 'h.installed',
      kind: 'header',
      section: 'plugins.installed',
      title: t('plugins.sections.installed'),
      right: String(plugins.length),
    });
    if (plugins.length === 0) {
      lines.push({ key: 'e.installed', kind: 'row', dim: true, text: t('plugins.empty') });
    }
    plugins.forEach((plugin, index) => {
      const state = stateOf(plugin, scenarioId);
      const label =
        scenarioId === undefined && state === 'off' ? '' : `  ${t(`plugins.state.${state}`)}`;
      lines.push({
        key: `p.${plugin.id}`,
        kind: 'row',
        section: 'plugins.installed',
        text: `${plugin.id}  ${plugin.version}${label}`,
        color: STATE_COLOR[state],
        selected: index === Math.min(cursor, plugins.length - 1),
      });
    });

    lines.push({
      key: 'h.detail',
      kind: 'header',
      section: 'plugins.detail',
      title: t('plugins.sections.detail'),
      right: selected?.id,
    });
    if (selected !== undefined) {
      const detailRows: Line[] = [];
      const row = (key: string, text: string, extra: Partial<Line> = {}): void => {
        detailRows.push({
          key: `d.${key}`,
          kind: 'row',
          section: 'plugins.detail',
          text,
          ...extra,
        });
      };
      row('origin', t('plugins.detail.origin', { origin: safeText(selected.origin) }));
      if (selected.description !== null) row('desc', safeText(selected.description));
      if (selected.problem !== null) {
        row('problem', t('plugins.detail.problem', { problem: safeText(selected.problem) }), {
          color: TOKEN.error,
        });
      }
      const pair = pairKey(selected.id, scenarioId);
      if (failed[pair] === true) {
        row('failed', t('plugins.detail.serverFailed'), { color: TOKEN.warn });
      }
      if (shown === undefined) {
        row('loading', t('plugins.detail.loading'), { dim: true });
      } else if (shown.detailError !== undefined) {
        row('err', t('plugins.detail.failed', { message: shown.detailError }), {
          color: TOKEN.error,
        });
      } else if (shown.detail !== undefined) {
        row('asks', t('plugins.detail.asks'), { dim: true });
        for (const [index, text] of activationRows(shown.detail, width - 3).entries()) {
          row(`a${String(index)}`, `  ${text}`, { dim: true });
        }
      }
      const secrets = secretRows(shown?.detail, missing[pair] ?? []);
      if (secrets.length > 0) {
        row('secrets', t('plugins.secrets.title'), { bold: true });
        for (const secret of secrets) {
          row(
            `s.${secret.name}`,
            `  ${secret.name}${secret.missing ? `  ${t('plugins.secrets.missing')}` : ''}`,
            { color: secret.missing ? TOKEN.warn : undefined },
          );
        }
        row('secrets.hint', t('plugins.secrets.hint'), { dim: true });
        for (const secret of secrets.filter(
          (entry) => entry.missing || missing[pair] === undefined,
        )) {
          row(`c.${secret.name}`, `  ${secretCommand(selected.id, secret.name, scenarioId)}`, {
            dim: true,
          });
        }
      }
      lines.push(...detailRows);
    }

    lines.push({
      key: 'h.panel',
      kind: 'header',
      section: 'plugins.panel',
      title: t('plugins.sections.panel'),
      right: selected?.id,
    });
    if (selected !== undefined) {
      const panelRow = (key: string, text: string, extra: Partial<Line> = {}): void => {
        lines.push({ key: `n.${key}`, kind: 'row', section: 'plugins.panel', text, ...extra });
      };
      if (selectedState === 'active' && scenarioId !== undefined) {
        if (shown === undefined) {
          panelRow('loading', t('plugins.panel.loading'), { dim: true });
        } else if (shown.panelError !== undefined) {
          panelRow('err', t('plugins.panel.failed', { message: shown.panelError }), {
            color: TOKEN.error,
          });
        } else if (panel !== undefined) {
          panel.lines.forEach((line, index) => {
            if (line.tone === 'action' && line.action !== undefined) {
              const entry = panel.actions[line.action];
              if (entry === undefined) return;
              const hint =
                entry.approval === 'none'
                  ? ''
                  : ` ${t(`plugins.action.approval.${entry.approval}`)}`;
              panelRow(`x${String(index)}`, `[ ${entry.label} ]${hint}`, {
                bold: true,
                selected: content.focused && line.action === actionIndex % actionCount,
              });
              return;
            }
            panelRow(`l${String(index)}`, line.text, {
              bold: line.tone === 'title' || line.tone === 'head',
              dim: line.tone === 'dim',
              color: PANEL_COLOR[line.tone],
            });
          });
          if (panel.actions.length > 0) {
            panelRow(
              'actionHint',
              t('plugins.action.hint', { next: keyOf('actionNext'), run: keyOf('action') }),
              {
                dim: true,
              },
            );
          }
        }
      } else if (selectedState === 'needs_approval') {
        panelRow('needs', t('plugins.panel.needsApproval', { key: keyOf('enable') }), {
          color: TOKEN.warn,
        });
      } else if (selectedState === 'broken') {
        panelRow('broken', t('plugins.panel.broken'), { color: TOKEN.error });
      } else {
        panelRow(
          'off',
          scenarioId === undefined
            ? t('plugins.panel.noProject')
            : t('plugins.panel.off', { key: keyOf('enable') }),
          { dim: true },
        );
      }
    }
  }

  // The folded sections keep their header only.
  const visible = lines.filter(
    (line) => line.kind === 'header' || !content.sections.folded.has(line.section ?? ''),
  );

  // Wrapped rows: a long one takes more than one line, none is cut.
  const wrapped: ReactNode[] = [];
  let cursorLine = 0;
  for (const line of [...head, ...visible]) {
    if (line.kind === 'header') {
      wrapped.push(
        <Section
          key={line.key}
          id={line.section ?? line.key}
          title={line.title ?? ''}
          right={line.right}
          width={width}
          control={content.sections}
        />,
      );
      continue;
    }
    if (line.selected === true) cursorLine = wrapped.length;
    const pieces = wrapText(line.text ?? '', Math.max(1, width - 1));
    pieces.forEach((piece, index) => {
      wrapped.push(
        <Text
          key={`${line.key}.${String(index)}`}
          wrap="truncate"
          bold={line.bold === true}
          dimColor={line.dim === true}
          {...paint(
            line.color,
            line.selected === true && content.focused ? TOKEN.selected : undefined,
          )}
        >
          {fit(`${line.selected === true && index === 0 ? '›' : ' '}${piece}`, width)}
        </Text>,
      );
    });
  }
  const first = Math.max(0, cursorLine - Math.max(1, content.height - 1));
  return (
    <Box flexDirection="column" width={width}>
      {wrapped.slice(first)}
    </Box>
  );
}

/** The tab Plugins with its routes; the tests give it a fake API. */
export function createPluginsTab(options: PluginsTabOptions = {}): PluginsTabDefinition {
  return {
    sections: SECTION_IDS,
    render: (content) => createElement(PluginsTab, { content, options }),
  };
}

export const pluginsTab: PluginsTabDefinition = createPluginsTab();
