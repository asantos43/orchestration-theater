// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import type {
  AddProfileBody,
  ApiConfig,
  ApiExecutor,
  ApiProfile,
  ApiRoles,
  ConfigEditBody,
  StartProfileLoginResult,
} from '@otheater/protocol';
import { Box, Text, useApp } from 'ink';
import { spawn } from 'node:child_process';
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
import { useRawKeys, type KeyEvent } from '../../keys/use-keymap.js';
import { keyLabel } from '../../keys/labels.js';
import { useTabHost } from '../../layout/tab-host.js';
import type { TabContentProps } from '../../layout/tab-types.js';
import { useRenderControl } from '../../render-control.js';
import { Section } from '../../layout/section.js';
import { breakLine, cellWidth, fit, wrapText } from '../../layout/text.js';
import { COLOR, paint } from '../../layout/theme.js';
import { isRemote } from '../../mouse/clipboard.js';
import { useCopyToClipboard } from '../../mouse/index.js';
import {
  hyperlink,
  openUrl,
  runOpenCommand,
  type OpenOutcome,
  type OpenPorts,
} from '../../open-url.js';
import { useStoreValue } from '../../use-store-value.js';
import { apiOf, type SettingsApi } from './api.js';
import { fieldStep } from './field.js';
import {
  LIMIT_KEYS,
  SECTION_IDS,
  WHEN_EXHAUSTED_CHOICES,
  addLoginModeOf,
  flatten,
  formatSpan,
  limitEdit,
  limitUnsetEdit,
  limitValueText,
  moved,
  nextChoice,
  parseAddForm,
  parseLimit,
  quotaLine,
  reorderEdit,
  roleItems,
  ruleEdit,
  type LimitKey,
  type SettingsSection,
} from './model.js';

/**
 * The tab Settings (§5.13; P16 of Phase 7; N186 and N188): the accounts, the Executors, the roles
 * and the limits, with the commands that change them. It reads through {@link SettingsApi} once
 * when it opens and again only when an event says what it shows changed (`profile.*`,
 * `executor.changed`, `config.changed`); the quota is the one the stores keep live. Writes go to
 * `PUT /v1/config` and the accounts routes, and what the daemon refuses is shown as it said it.
 */

/** Runs a command in the terminal of the person, with it handed over; resolves with the exit code. */
export type LocalRunner = (command: string) => Promise<number | null>;

/** `ot profile exec claude-code/main login`: the words, run with the terminal as is. */
export const runInTerminal: LocalRunner = (command) =>
  new Promise((resolve, reject) => {
    const [program, ...args] = command.trim().split(/\s+/);
    if (program === undefined || program === '') {
      reject(new Error('no command'));
      return;
    }
    const child = spawn(program, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code);
    });
  });

export interface SettingsTabDefinition {
  readonly sections: readonly string[];
  readonly render: (props: TabContentProps) => ReactNode;
}

export interface SettingsTabOptions {
  /** The routes of the tab; default: the client of the daemon the TUI is connected to. */
  readonly api?: SettingsApi | undefined;
  /** How a login that the daemon leaves to the terminal runs; default: the command itself, with the terminal. */
  readonly runLocal?: LocalRunner | undefined;
  /** The clock of the quota resets; default: the system's. */
  readonly now?: (() => number) | undefined;
  /** How the sign-in panel opens the address in the browser; default: the command of the system. The tests give a fake `run`. */
  readonly open?: Partial<OpenPorts> | undefined;
}

/**
 * The keys of the sign-in panel [proposta]. The panel reads the keys itself and, when the client
 * takes a code, the letters go to the field of the code, so these are Ctrl+letter: a terminal sends
 * them as control characters, which the field never takes as text (and `Ctrl+Y`, `Ctrl+O` are not
 * used by the field, by the setup or by the global shortcuts, which are off while the panel reads).
 */
export const LOGIN_OPEN_KEY = 'Ctrl+O';
export const LOGIN_COPY_KEY = 'Ctrl+Y';

/** The id that ties the rows of one address into one hyperlink (OSC 8). */
const LOGIN_LINK_ID = 'otheater-login';

/** What the address shows as: a control character of the client's output is never drawn (it could be a terminal escape). */
// eslint-disable-next-line no-control-regex
const printable = (address: string): string => address.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');

type Scope = 'global' | 'project';
type Tone = 'ok' | 'warn' | 'error';

interface Message {
  readonly text: string;
  readonly tone: Tone;
}

interface Loaded {
  readonly profiles: readonly ApiProfile[];
  readonly executors: readonly ApiExecutor[];
  readonly roles: ApiRoles;
  readonly config: ApiConfig;
}

type Prompt =
  | { readonly purpose: 'add' }
  | { readonly purpose: 'apiKey'; readonly draft: AddProfileBody }
  | { readonly purpose: 'limit'; readonly spec: LimitKey };

type Mode =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'prompt';
      readonly prompt: Prompt;
      readonly label: string;
      readonly secret: boolean;
      readonly value: string;
    }
  | {
      readonly kind: 'confirm';
      readonly question: string;
      readonly then: () => void;
    }
  | {
      readonly kind: 'login';
      readonly profileId: string;
      readonly info: Extract<StartProfileLoginResult, { status: 'started' }>;
      readonly value: string;
      readonly sent: boolean;
    };

const IDLE: Mode = { kind: 'idle' };

const TONE_COLOR: Readonly<Record<Tone, string>> = {
  ok: COLOR.ok,
  warn: COLOR.warn,
  error: COLOR.error,
};

const QUOTA_COLOR = {
  ok: COLOR.ok,
  near_limit: COLOR.warn,
  exhausted: COLOR.error,
  unknown: undefined,
} as const;

/** The message of an error of the client without the route and status prefix, or the issues it lists. */
export function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const issues = (error.details as { issues?: unknown } | undefined)?.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .map((issue: { path?: unknown; message?: unknown }) => {
          const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : '';
          const message = typeof issue.message === 'string' ? issue.message : '';
          return path === '' ? message : `${path}: ${message}`;
        })
        .join('; ');
    }
    return error.message.replace(/^[^:]*: \w+ \(HTTP \d+\): /, '');
  }
  return error instanceof Error ? error.message : String(error);
}

/** One line of what the tab draws. */
interface Line {
  readonly key: string;
  readonly kind: 'header' | 'row';
  readonly section?: SettingsSection;
  readonly title?: string;
  readonly right?: string;
  readonly text?: string;
  /** The row is (a piece of) this address: it is drawn as a hyperlink and broken in place, never cut. */
  readonly link?: string;
  readonly color?: string | undefined;
  readonly dim?: boolean;
  readonly selected?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface TabProps {
  readonly content: TabContentProps;
  readonly options: SettingsTabOptions;
}

function SettingsTab({ content, options }: TabProps): ReactNode {
  const { t } = useTranslation();
  const { stores, keymap, capture, openAssistant, settings } = useTabHost();
  const copyToClipboard = useCopyToClipboard();
  const scenarioId = content.scenarioId;
  const { suspendTerminal } = useApp();
  const { afterKey } = useRenderControl();
  const api = useMemo(() => options.api ?? apiOf(stores.client), [options.api, stores]);
  const now = options.now ?? Date.now;
  const runLocal = options.runLocal ?? runInTerminal;
  const openPorts = useMemo(
    (): OpenPorts => ({
      run: runOpenCommand,
      environment: { platform: process.platform, env: process.env },
      ...options.open,
    }),
    [options.open],
  );
  const loginBrowser = settings.login.browser;

  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [scope, setScope] = useState<Scope>('global');
  const [override, setOverride] = useState<readonly (readonly [string, string])[] | undefined>(
    undefined,
  );
  const [cursors, setCursors] = useState<Readonly<Record<SettingsSection, number>>>({
    'settings.subscriptions': 0,
    'settings.executors': 0,
    'settings.roles': 0,
    'settings.limits': 0,
  });
  const [mode, setModeState] = useState<Mode>(IDLE);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const modeRef = useRef<Mode>(IDLE);
  const mounted = useRef(true);
  const busy = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endedLogins = useRef(new Map<string, Message>());
  const loadedRef = useRef<Loaded | undefined>(undefined);
  loadedRef.current = loaded;
  const quotas = useStoreValue(stores.quotas, (state) => state.byProfile);

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
      capture.current = next.kind !== 'idle';
    },
    [capture],
  );

  const say = useCallback((text: string, tone: Tone): void => {
    if (mounted.current) setMessage({ text, tone });
  }, []);

  const failed = useCallback(
    (error: unknown): void => {
      say(t('settings.result.failed', { message: errorText(error) }), 'error');
    },
    [say, t],
  );

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [profiles, executors, roles, config] = await Promise.all([
        api.profiles(),
        api.executors(),
        api.roles(),
        api.config(),
      ]);
      if (!mounted.current) return;
      setLoaded({ profiles, executors, roles, config });
      setLoadError(undefined);
    } catch (error) {
      if (mounted.current) setLoadError(errorText(error));
    }
  }, [api]);

  const reloadSoon = useCallback((): void => {
    if (reloadTimer.current !== undefined) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = undefined;
      void reload();
    }, 30);
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The events that say what the tab shows changed, and the end of a login.
  const lastEvent = useRef(
    stores.events.getState().events.reduce((top, event) => Math.max(top, event.id), 0),
  );
  const onEvent = useEffectEvent((type: string, payload: Record<string, unknown>): void => {
    if (type === 'profile.login.completed' || type === 'profile.login.failed') {
      const profileId = typeof payload.profileId === 'string' ? payload.profileId : '';
      const reason = typeof payload.reason === 'string' ? payload.reason : 'error';
      const end: Message =
        type === 'profile.login.completed'
          ? { text: t('settings.login.completed', { profile: profileId }), tone: 'ok' }
          : {
              text: t('settings.login.failed', {
                profile: profileId,
                reason: t(`settings.login.reason.${reason}`),
              }),
              tone: reason === 'cancelled' ? 'warn' : 'error',
            };
      endedLogins.current.set(profileId, end);
      const current = modeRef.current;
      if (current.kind === 'login' && current.profileId === profileId) {
        setMode(IDLE);
        setMessage(end);
      }
      reloadSoon();
      return;
    }
    if (
      type.startsWith('profile.') ||
      type === 'executor.changed' ||
      type === 'config.changed' ||
      type === 'config.edited'
    ) {
      reloadSoon();
    }
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

  // The keys the person pressed run on the data of the last render.
  const section = content.sections.cursor as SettingsSection | undefined;

  const itemCount = (id: SettingsSection): number => {
    if (loaded === undefined) return 0;
    switch (id) {
      case 'settings.subscriptions':
        return loaded.profiles.length;
      case 'settings.executors':
        return loaded.executors.length;
      case 'settings.roles':
        return roleItems(loaded.roles).length;
      case 'settings.limits':
        return LIMIT_KEYS.length;
    }
  };
  const cursorOf = (id: SettingsSection): number =>
    Math.min(cursors[id], Math.max(0, itemCount(id) - 1));

  /** Sends one edit of the configuration; what the daemon refuses is shown and nothing is written. */
  const write = async (edit: ConfigEditBody): Promise<void> => {
    if (scope === 'project') {
      say(t('settings.result.readOnly'), 'warn');
      return;
    }
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await api.putConfig(edit);
      const restart = result.restart.join(', ');
      const hot = result.hot.join(', ');
      say(
        restart === ''
          ? t('settings.result.hot', { keys: hot })
          : t('settings.result.restart', { keys: restart }),
        restart === '' ? 'ok' : 'warn',
      );
      await reload();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'invalid_input') {
        say(t('settings.result.invalid', { message: errorText(error) }), 'error');
      } else {
        failed(error);
      }
    } finally {
      busy.current = false;
    }
  };

  const addProfile = async (body: AddProfileBody): Promise<void> => {
    try {
      const result = await api.addProfile(body);
      if (result.status === 'needs_notice') {
        setMode({
          kind: 'confirm',
          question: t('settings.prompt.confirmNotice', {
            provider: result.notice.provider,
            existing: result.notice.existing.join(', '),
          }),
          then: () => {
            void addProfile({ ...body, acceptNotice: true });
          },
        });
        return;
      }
      say(t('settings.result.added', { profile: result.profile.id }), 'ok');
      // `profiles.add.login`: a subscription account with no login yet is offered one (or gets it at
      // once), the same login as the key `L`. Read before the reload, from the config the tab holds.
      const mode = addLoginModeOf(loadedRef.current?.config.config ?? {});
      const wantsLogin =
        result.profile.kind === 'token_plan' && result.login !== 'logged_in' && mode !== 'off';
      await reload();
      if (!wantsLogin) return;
      const profileId = result.profile.id;
      if (mode === 'auto') {
        await startLogin(profileId);
        return;
      }
      setMode({
        kind: 'confirm',
        question: t('settings.prompt.confirmLogin', { profile: profileId }),
        then: () => {
          void startLogin(profileId);
        },
      });
    } catch (error) {
      failed(error);
    }
  };

  const removeProfile = async (profileId: string): Promise<void> => {
    try {
      await api.removeProfile(profileId);
      say(t('settings.result.removed', { profile: profileId }), 'ok');
      await reload();
    } catch (error) {
      failed(error);
    }
  };

  const sayOpened = (outcome: OpenOutcome): void => {
    if (outcome.ok) {
      say(t('settings.login.opened', { command: outcome.command }), 'ok');
    } else {
      say(
        t(`settings.login.openFailed.${outcome.reason}`, {
          command: outcome.command ?? '',
          copy: LOGIN_COPY_KEY,
        }),
        'warn',
      );
    }
  };

  // Opens the address in the browser (`auto` when the sign-in starts, the key after that). `off`
  // never opens; over SSH the browser would open on the other machine, so it only says so.
  const openAddress = async (url: string | null, by: 'auto' | 'key'): Promise<void> => {
    if (url === null) return;
    if (loginBrowser === 'off') {
      if (by === 'key') say(t('settings.login.openOff', { copy: LOGIN_COPY_KEY }), 'warn');
      return;
    }
    sayOpened(await openUrl(url, openPorts));
  };

  const copyAddress = async (url: string | null): Promise<void> => {
    if (url === null) return;
    const text = printable(url);
    const outcome =
      copyToClipboard === undefined
        ? ({ ok: false, reason: 'off' } as const)
        : await copyToClipboard(text);
    if (outcome.ok) {
      say(t(`settings.login.copied.${outcome.via}`, { chars: outcome.chars }), 'ok');
    } else if (outcome.reason === 'empty') {
      say(t('settings.login.noUrl'), 'warn');
    } else {
      say(t(`layout.mouse.copyFailed.${outcome.reason}`), 'warn');
    }
  };

  const startLogin = async (profileId: string): Promise<void> => {
    endedLogins.current.delete(profileId);
    try {
      const result = await api.startLogin(profileId);
      if (result.status === 'local') {
        const exit: { code: number | null } = { code: null };
        let problem: string | undefined;
        try {
          await suspendTerminal(async () => {
            exit.code = await runLocal(result.command);
          });
        } catch (error) {
          problem = errorText(error);
        }
        if (problem !== undefined) {
          say(t('settings.login.terminalFailed', { message: problem }), 'error');
        } else {
          say(
            t('settings.login.terminalDone', { profile: profileId, code: String(exit.code) }),
            exit.code === 0 ? 'ok' : 'warn',
          );
        }
        reloadSoon();
        return;
      }
      const ended = endedLogins.current.get(profileId);
      if (ended !== undefined) {
        // The end came before the answer that opens the panel.
        setMessage(ended);
        return;
      }
      setMode({ kind: 'login', profileId, info: result, value: '', sent: false });
      // `ui.login.browser: auto`: the way the official clients do it, the browser opens on its own, once.
      if (loginBrowser === 'auto') void openAddress(result.url, 'auto');
    } catch (error) {
      failed(error);
    }
  };

  const openScope = async (): Promise<void> => {
    if (scope === 'project') {
      setScope('global');
      return;
    }
    setScope('project');
    setOverride(undefined);
    if (scenarioId === undefined) return;
    try {
      const value = await api.scenarioOverride(scenarioId);
      if (mounted.current) setOverride(flatten(value));
    } catch (error) {
      failed(error);
    }
  };

  const openPrompt = (prompt: Prompt, label: string, secret = false): void => {
    setMode({ kind: 'prompt', prompt, label, secret, value: '' });
  };

  const submitPrompt = (current: Extract<Mode, { kind: 'prompt' }>): void => {
    const { prompt, value } = current;
    setMode(IDLE);
    switch (prompt.purpose) {
      case 'add': {
        const form = parseAddForm(value);
        if (form === undefined) {
          say(t('settings.result.badAdd'), 'warn');
          return;
        }
        if (form.kind === 'api') {
          openPrompt(
            { purpose: 'apiKey', draft: form },
            t('settings.prompt.apiKey', { profile: `${form.client}/${form.name}` }),
            true,
          );
          return;
        }
        void addProfile(form);
        return;
      }
      case 'apiKey':
        if (value === '') return;
        void addProfile({ ...prompt.draft, apiKey: value });
        return;
      case 'limit': {
        const parsed = parseLimit(prompt.spec, value);
        if (parsed === undefined) {
          say(
            t(
              prompt.spec.kind === 'count'
                ? 'settings.result.badWhole'
                : 'settings.result.badDuration',
              { key: prompt.spec.key, min: prompt.spec.min ?? 0 },
            ),
            'warn',
          );
          return;
        }
        void write(limitEdit(prompt.spec.key, parsed));
        return;
      }
    }
  };

  const endLogin = (current: Extract<Mode, { kind: 'login' }>): void => {
    setMode(IDLE);
    setMessage({ text: t('settings.login.cancelled'), tone: 'warn' });
    void api.cancelLogin(current.profileId).catch((error: unknown) => {
      failed(error);
    });
  };

  const handleMode = (event: KeyEvent, current: Exclude<Mode, { kind: 'idle' }>): void => {
    if (current.kind === 'confirm') {
      setMode(IDLE);
      const yes = t('settings.prompt.yes').toUpperCase();
      if ((event.combo ?? '').toUpperCase() === yes) current.then();
      return;
    }
    if (current.kind === 'login') {
      if (event.combo === 'Esc') {
        endLogin(current);
        return;
      }
      if (event.combo === LOGIN_OPEN_KEY) {
        void openAddress(current.info.url, 'key');
        return;
      }
      if (event.combo === LOGIN_COPY_KEY) {
        void copyAddress(current.info.url);
        return;
      }
      if (!current.info.takesCode) return;
      const step = fieldStep(current.value, event.combo, event.data);
      if (step.done === 'submit') {
        if (current.value.trim() === '') return;
        const code = current.value.trim();
        setMode({ ...current, value: '', sent: true });
        void api.submitLoginCode(current.profileId, code).catch((error: unknown) => {
          failed(error);
        });
        return;
      }
      if (step.done === 'cancel') return;
      setMode({ ...current, value: step.value });
      return;
    }
    const step = fieldStep(current.value, event.combo, event.data);
    if (step.done === 'cancel') {
      setMode(IDLE);
      return;
    }
    if (step.done === 'submit') {
      submitPrompt(current);
      return;
    }
    setMode({ ...current, value: step.value });
  };

  const move = (id: SettingsSection, delta: -1 | 1): void => {
    const last = Math.max(0, itemCount(id) - 1);
    setCursors((now$) => ({
      ...now$,
      [id]: Math.min(last, Math.max(0, Math.min(now$[id], last) + delta)),
    }));
  };

  const handleIdle = (event: KeyEvent): void => {
    if (event.combo === undefined) return;
    const action = keymap.match(event.combo, ['settings']);
    if (!action?.startsWith('settings.')) return;
    if (message !== undefined) setMessage(undefined);
    const data = loadedRef.current;
    const name = action.slice('settings.'.length);
    if (name === 'scope') {
      void openScope();
      return;
    }
    if (name === 'add') {
      openPrompt({ purpose: 'add' }, t('settings.prompt.add'));
      return;
    }
    // The setup assistant (P17): the same screen, on the flow that fits the key.
    if (name === 'assistantAccount' || name === 'assistantPreset' || name === 'assistantFirstRun') {
      if (openAssistant === undefined) {
        say(t('settings.result.noAssistant'), 'warn');
      } else if (scope === 'project') {
        say(t('settings.result.readOnly'), 'warn');
      } else {
        openAssistant(
          name === 'assistantAccount'
            ? 'add_account'
            : name === 'assistantPreset'
              ? 'change_preset'
              : 'first_run',
        );
      }
      return;
    }
    if (section === undefined || data === undefined) return;
    if (name === 'itemPrev' || name === 'itemNext') {
      move(section, name === 'itemPrev' ? -1 : 1);
      return;
    }
    const at = cursorOf(section);
    if (section === 'settings.subscriptions') {
      const profile = data.profiles[at];
      if (profile === undefined) {
        say(t('settings.result.nothing'), 'warn');
        return;
      }
      if (name === 'login') {
        if (profile.profile.kind !== 'token_plan') {
          say(t('settings.result.noLogin'), 'warn');
          return;
        }
        void startLogin(profile.profile.id);
      } else if (name === 'remove') {
        const profileId = profile.profile.id;
        setMode({
          kind: 'confirm',
          question: t('settings.prompt.confirmRemove', { profile: profileId }),
          then: () => {
            void removeProfile(profileId);
          },
        });
      }
      return;
    }
    if (section === 'settings.roles') {
      const item = roleItems(data.roles)[at];
      const role =
        item === undefined ? undefined : data.roles.roles.find((r) => r.role === item.role);
      if (item === undefined || role === undefined) return;
      if (name === 'moveUp' || name === 'moveDown') {
        if (item.kind !== 'executor') return;
        const ids = role.executors.map((executor) => executor.id);
        const next = moved(ids, item.index, name === 'moveUp' ? -1 : 1);
        if (next === undefined) return;
        // The cursor follows the Executor it moved.
        move(section, name === 'moveUp' ? -1 : 1);
        void write(reorderEdit(item.role, next));
      } else if (name === 'edit' && item.kind === 'rule') {
        void write(
          ruleEdit(
            item.role,
            nextChoice(WHEN_EXHAUSTED_CHOICES, role.whenExhausted) as 'next' | 'wait',
          ),
        );
      } else if (name === 'unset') {
        void write({
          remove: [['roles', item.role, item.kind === 'rule' ? 'when_exhausted' : 'executors']],
        });
      }
      return;
    }
    if (section === 'settings.limits') {
      const spec = LIMIT_KEYS[at];
      if (spec === undefined) return;
      if (name === 'unset') {
        void write(limitUnsetEdit(spec.key));
      } else if (name === 'edit') {
        const limits = isRecord(data.config.config.limits) ? data.config.config.limits : {};
        if (spec.kind === 'choice' && spec.choices !== undefined) {
          void write(limitEdit(spec.key, nextChoice(spec.choices, limits[spec.key])));
        } else {
          openPrompt(
            { purpose: 'limit', spec },
            t('settings.prompt.limit', {
              key: spec.key,
              hint: t(spec.kind === 'count' ? 'settings.hint.whole' : 'settings.hint.duration', {
                min: spec.min ?? 0,
              }),
            }),
          );
        }
      }
    }
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

  // What it draws.
  const width = content.width;
  const clock = now();
  const lines: Line[] = [];
  const onCursor = (id: SettingsSection, index: number): boolean =>
    content.focused && section === id && cursorOf(id) === index;

  if (loaded !== undefined) {
    const limits = isRecord(loaded.config.config.limits) ? loaded.config.config.limits : {};
    lines.push({
      key: 'h.subs',
      kind: 'header',
      section: 'settings.subscriptions',
      title: t('settings.sections.subscriptions'),
      right: String(loaded.profiles.length),
    });
    if (loaded.profiles.length === 0) {
      lines.push({ key: 'e.subs', kind: 'row', text: t('settings.empty.profiles'), dim: true });
    }
    loaded.profiles.forEach((entry, index) => {
      const id = entry.profile.id;
      const line = quotaLine(quotas[id] ?? entry.quota, clock);
      const parts = [id, entry.profile.kind];
      if (entry.profile.state !== 'active')
        parts.push(t(`settings.profile.${entry.profile.state}`));
      if (entry.profile.kind === 'api' && !entry.hasSecret)
        parts.push(t('settings.profile.noSecret'));
      parts.push(t(`settings.quota.${line.state}`));
      if (line.percent !== undefined)
        parts.push(t('settings.profile.used', { percent: line.percent }));
      if (line.resetsIn !== undefined) {
        parts.push(t('settings.profile.resets', { time: formatSpan(line.resetsIn) }));
      }
      lines.push({
        key: `s.${id}`,
        kind: 'row',
        section: 'settings.subscriptions',
        text: parts.join('  '),
        color: QUOTA_COLOR[line.state],
        selected: onCursor('settings.subscriptions', index),
      });
    });

    lines.push({
      key: 'h.exec',
      kind: 'header',
      section: 'settings.executors',
      title: t('settings.sections.executors'),
      right: String(loaded.executors.length),
    });
    if (loaded.executors.length === 0) {
      lines.push({ key: 'e.exec', kind: 'row', text: t('settings.empty.executors'), dim: true });
    }
    loaded.executors.forEach((executor, index) => {
      const parts: string[] = [executor.id];
      if (executor.validity === 'invalid') {
        parts.push(t('settings.executor.invalid', { reason: executor.invalidReason ?? '' }));
      }
      parts.push(
        executor.roles.length === 0
          ? t('settings.executor.noRoles')
          : t('settings.executor.roles', { roles: executor.roles.join(', ') }),
      );
      lines.push({
        key: `x.${executor.id}`,
        kind: 'row',
        section: 'settings.executors',
        text: parts.join('  '),
        color: executor.validity === 'invalid' ? COLOR.warn : undefined,
        selected: onCursor('settings.executors', index),
      });
    });

    lines.push({
      key: 'h.roles',
      kind: 'header',
      section: 'settings.roles',
      title: t('settings.sections.roles'),
      right: loaded.roles.preset,
    });
    if (loaded.roles.roles.length === 0) {
      lines.push({ key: 'e.roles', kind: 'row', text: t('settings.empty.roles'), dim: true });
    }
    roleItems(loaded.roles).forEach((item, index) => {
      const role = loaded.roles.roles.find((candidate) => candidate.role === item.role);
      if (role === undefined) return;
      const selected = onCursor('settings.roles', index);
      if (item.kind === 'rule') {
        lines.push({
          key: `r.${item.role}`,
          kind: 'row',
          section: 'settings.roles',
          text: `${item.role}  ${t('settings.role.rule', { rule: t(`settings.role.${role.whenExhausted}`) })}`,
          selected,
        });
        return;
      }
      const executor = role.executors[item.index];
      if (executor === undefined) return;
      const blocked =
        executor.blockedBy === null
          ? ''
          : `  [${t(`settings.role.blocked.${executor.blockedBy}`)}]`;
      lines.push({
        key: `r.${item.role}.${String(item.index)}`,
        kind: 'row',
        section: 'settings.roles',
        text: `  ${String(item.index + 1)}. ${executor.id}${blocked}`,
        color: executor.blockedBy === null ? undefined : COLOR.warn,
        selected,
      });
    });

    lines.push({
      key: 'h.limits',
      kind: 'header',
      section: 'settings.limits',
      title: t('settings.sections.limits'),
      right: typeof limits.preset === 'string' ? limits.preset : '-',
    });
    LIMIT_KEYS.forEach((spec, index) => {
      lines.push({
        key: `l.${spec.key}`,
        kind: 'row',
        section: 'settings.limits',
        text: `${spec.key} = ${limitValueText(spec, limits[spec.key])}`,
        selected: onCursor('settings.limits', index),
      });
    });
  }

  // The folded sections keep their header only.
  const visible = lines.filter(
    (line) => line.kind === 'header' || !content.sections.folded.has(line.section ?? ''),
  );
  // The rows the tab keeps in view: from the line of the cursor, so it never leaves the screen.
  const head: Line[] = [];
  const scopeKey = keyLabel(keymap, 'settings.scope') ?? '';
  head.push({
    key: 'scope',
    kind: 'row',
    dim: true,
    text:
      scope === 'global'
        ? t('settings.scope.global', { key: scopeKey })
        : scenarioId === undefined
          ? t('settings.scope.noProject', { key: scopeKey })
          : t('settings.scope.project', {
              name: stores.scenarios.getState().byId[scenarioId]?.name ?? scenarioId,
              key: scopeKey,
            }),
  });
  if (mode.kind === 'prompt') {
    head.push({ key: 'p.label', kind: 'row', text: mode.label, color: COLOR.accent });
    head.push({
      key: 'p.value',
      kind: 'row',
      text: `> ${mode.secret ? '•'.repeat(Array.from(mode.value).length) : mode.value}▏`,
    });
    head.push({ key: 'p.hint', kind: 'row', text: t('settings.prompt.hintEnter'), dim: true });
  } else if (mode.kind === 'confirm') {
    head.push({ key: 'c.q', kind: 'row', text: mode.question, color: COLOR.warn });
    head.push({ key: 'c.hint', kind: 'row', text: t('settings.prompt.hintConfirm'), dim: true });
  } else if (mode.kind === 'login') {
    head.push({
      key: 'g.title',
      kind: 'row',
      text: t('settings.login.title', { profile: mode.profileId }),
      color: COLOR.accent,
    });
    head.push({ key: 'g.mode', kind: 'row', text: t(`settings.login.mode.${mode.info.mode}`) });
    if (mode.info.url === null) {
      head.push({ key: 'g.url', kind: 'row', text: t('settings.login.noUrl') });
    } else {
      head.push({ key: 'g.url', kind: 'row', text: t('settings.login.url') });
      head.push({
        key: 'g.link',
        kind: 'row',
        text: printable(mode.info.url),
        link: mode.info.url,
        color: COLOR.accent,
      });
      const canOpen = loginBrowser !== 'off' && !isRemote(openPorts.environment);
      head.push({
        key: 'g.keys',
        kind: 'row',
        dim: true,
        text: t(canOpen ? 'settings.login.keys.both' : 'settings.login.keys.copy', {
          open: LOGIN_OPEN_KEY,
          copy: LOGIN_COPY_KEY,
        }),
      });
    }
    if (mode.info.code !== null) {
      head.push({
        key: 'g.code',
        kind: 'row',
        text: t('settings.login.code', { code: mode.info.code }),
        color: COLOR.warn,
      });
    }
    if (mode.info.takesCode) {
      head.push({ key: 'g.takes', kind: 'row', text: t('settings.login.takesCode'), dim: true });
      head.push({ key: 'g.field', kind: 'row', text: `> ${mode.value}▏` });
    } else {
      head.push({ key: 'g.cancel', kind: 'row', text: t('settings.login.cancelHint'), dim: true });
    }
    head.push({ key: 'g.wait', kind: 'row', text: t('settings.login.waiting'), dim: true });
  }
  if (message !== undefined) {
    head.push({ key: 'm', kind: 'row', text: message.text, color: TONE_COLOR[message.tone] });
  }
  if (loaded === undefined) {
    head.push({
      key: 'load',
      kind: 'row',
      dim: loadError === undefined,
      color: loadError === undefined ? undefined : COLOR.error,
      text:
        loadError === undefined
          ? t('settings.loading')
          : t('settings.loadFailed', { message: loadError }),
    });
  }

  // The project scope shows the override of the scenario in place of the sections.
  let body: Line[] = visible;
  if (scope === 'project') {
    body = [];
    if (scenarioId !== undefined && override !== undefined) {
      if (override.length === 0) {
        body.push({ key: 'o.none', kind: 'row', text: t('settings.empty.overrides'), dim: true });
      }
      for (const [path, value] of override) {
        body.push({ key: `o.${path}`, kind: 'row', text: `${path} = ${value}` });
      }
    }
  }

  // Wrapped rows: the long ones (an address) take more than one line, none is cut.
  const wrapped: ReactNode[] = [];
  const all = [...head, ...body];
  let cursorLine = 0;
  for (const line of all) {
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
    if (line.link !== undefined) {
      // An address: broken exactly at the width (a long one takes several rows, none is cut) and
      // each row is the same OSC 8 link, so the terminal sees one address. The padding is counted
      // on the text, since `fit` would count the escape of the link as cells.
      const room = Math.max(1, width - 1);
      breakLine(line.text ?? '', room).forEach((piece, index) => {
        const padding = ' '.repeat(Math.max(0, room - cellWidth(piece)));
        wrapped.push(
          <Text
            key={`${line.key}.${String(index)}`}
            wrap="truncate"
            {...paint(line.color, undefined)}
          >
            {` ${hyperlink(piece, line.link ?? '', LOGIN_LINK_ID)}${padding}`}
          </Text>,
        );
      });
      continue;
    }
    const pieces = wrapText(line.text ?? '', Math.max(1, width - 1));
    pieces.forEach((piece, index) => {
      wrapped.push(
        <Text
          key={`${line.key}.${String(index)}`}
          wrap="truncate"
          dimColor={line.dim === true}
          {...paint(line.color, line.selected === true ? COLOR.selected : undefined)}
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

/** The tab Settings with its routes; the tests give it a fake API and a runner of their own. */
export function createSettingsTab(options: SettingsTabOptions = {}): SettingsTabDefinition {
  return {
    sections: SECTION_IDS,
    render: (content) => createElement(SettingsTab, { content, options }),
  };
}

export const settingsTab: SettingsTabDefinition = createSettingsTab();
