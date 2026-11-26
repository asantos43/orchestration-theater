// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import type {
  AddProfileBody,
  ApiConfig,
  ApiExecutor,
  ApiProfile,
  ApiQuotaStatus,
  ApiRoles,
  ConfigEditBody,
  StartProfileLoginResult,
} from '@otheater/protocol';
import { Box } from 'ink';
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
import { breakLine, cellWidth, clip, fit, wrapText } from '../../layout/text.js';
import { paint, TOKEN } from '../../layout/theme.js';
import { Text } from '../../layout/themed-text.js';
import { isRemote } from '../../mouse/clipboard.js';
import { useCopyToClipboard, useSuspendTerminal } from '../../mouse/index.js';
import {
  hyperlink,
  openUrl,
  runOpenCommand,
  type OpenOutcome,
  type OpenPorts,
} from '../../open-url.js';
import { useStoreValue } from '../../use-store-value.js';
import {
  accountFormKey,
  accountFormLines,
  accountFormStart,
  unknownClientText,
  type AccountForm,
} from '../../setup/account-form.js';
import {
  choiceOf,
  modelPickKey,
  modelPickLines,
  modelPickStart,
  seedOfChoices,
  type ModelChoice,
  type ModelPick,
} from '../../setup/model-pick.js';
import { apiOf, type SettingsApi } from './api.js';
import { fieldStep } from './field.js';
import {
  LIMIT_KEYS,
  SECTION_IDS,
  WHEN_EXHAUSTED_CHOICES,
  addLoginModeOf,
  alignColumns,
  flatten,
  formatSpan,
  limitEdit,
  limitUnsetEdit,
  limitValueText,
  moveRoleCursor,
  moved,
  nextChoice,
  parseLimit,
  quotaLine,
  reorderEdit,
  roleItems,
  ruleEdit,
  settingsFolded,
  windowCell,
  windowColumns,
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

/** The keys that add an account, as the keymap has them, for the texts of an empty list (N324). */
function addKeysOf(keymap: Parameters<typeof keyLabel>[0]): { add: string; assistant: string } {
  return {
    add: keyLabel(keymap, 'settings.add') ?? 'A',
    assistant: keyLabel(keymap, 'settings.assistantAccount') ?? 'W',
  };
}

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

/** What a typed line is for: the value of a key of `limits` (the account has its form, N326). */
interface Prompt {
  readonly purpose: 'limit';
  readonly spec: LimitKey;
}

type Mode =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'prompt';
      readonly prompt: Prompt;
      readonly label: string;
      readonly secret: boolean;
      readonly value: string;
    }
  /** The form that adds an account (N326). */
  | { readonly kind: 'form'; readonly form: AccountForm }
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
    }
  /** N324, part B2: the models of an account added with A, after its login. */
  | { readonly kind: 'models'; readonly pick: ModelPick }
  /** N324, part B2: the client says the new account is not logged in; L tries again, S goes on. */
  | { readonly kind: 'loginCheck'; readonly profileId: string };

const IDLE: Mode = { kind: 'idle' };

const TONE_COLOR: Readonly<Record<Tone, string>> = {
  ok: TOKEN.ok,
  warn: TOKEN.warn,
  error: TOKEN.error,
};

const QUOTA_COLOR = {
  ok: TOKEN.ok,
  near_limit: TOKEN.warn,
  exhausted: TOKEN.error,
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
  // The login of the client takes the terminal: the mouse reports go off while it runs and on again
  // after, since a client may turn them off when it ends (only the keys would answer otherwise).
  const suspendTerminal = useSuspendTerminal();
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
  // `ui.settingsTab.roles: line`: the role whose list is open; `undefined` is the first one.
  const [openRole, setOpenRole] = useState<string | null | undefined>(undefined);
  const rolesMode = settings.settingsTab.roles;
  const roleView = (roles: ApiRoles): { readonly open: string | null } | undefined =>
    rolesMode === 'list'
      ? undefined
      : { open: openRole === undefined ? (roles.roles[0]?.role ?? null) : openRole };
  const [mode, setModeState] = useState<Mode>(IDLE);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const modeRef = useRef<Mode>(IDLE);
  const mounted = useRef(true);
  const busy = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endedLogins = useRef(new Map<string, Message>());
  // N324, part B2: the accounts added with A whose login, once it ends, opens the list of models.
  const pickAfterLogin = useRef(new Set<string>());
  const modelPick = settings.setup.modelPick;
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
      void loginEnded(profileId);
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
        return roleItems(loaded.roles, roleView(loaded.roles)).length;
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
      // `profiles.add.login`: a subscription account with no login yet gets it at once, the same
      // login as the key `L` (N326: the Enter of the form is the yes, so `ask` logs in as `auto`
      // does here [proposta]); `off` never does. Read before the reload, from the config the tab holds.
      const mode = addLoginModeOf(loadedRef.current?.config.config ?? {});
      const subscription = result.profile.kind === 'token_plan';
      const wantsLogin = subscription && result.login !== 'logged_in' && mode !== 'off';
      await reload();
      if (wantsLogin) {
        pickAfterLogin.current.add(result.profile.id);
        await startLogin(result.profile.id);
      } else if (subscription && result.login === 'logged_in') {
        // Logged in already: the list opens at once (N324, part B2).
        await afterLogin(result.profile.id);
      }
    } catch (error) {
      const unknown = unknownClientText(error, t);
      if (unknown === undefined) failed(error);
      else say(unknown, 'error');
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
        await loginEnded(profileId);
        return;
      }
      const ended = endedLogins.current.get(profileId);
      if (ended !== undefined) {
        // The end came before the answer that opens the panel.
        setMessage(ended);
        await loginEnded(profileId);
        return;
      }
      setMode({ kind: 'login', profileId, info: result, value: '', sent: false });
      // `ui.login.browser: auto`: the way the official clients do it, the browser opens on its own, once.
      if (loginBrowser === 'auto') void openAddress(result.url, 'auto');
    } catch (error) {
      pickAfterLogin.current.delete(profileId);
      failed(error);
    }
  };

  /** The login of an account added with A ended (or the client ran it): the list of models comes. */
  const loginEnded = async (profileId: string): Promise<void> => {
    if (!pickAfterLogin.current.delete(profileId)) return;
    await afterLogin(profileId);
  };

  /**
   * N324, part B2 (the owner on 2026-11-26, "Também"): after the login of an account added with A,
   * the same list as the assistant's. The client says whether the account is logged in; when it is
   * not, L logs in again and S goes on. With no route of the assistant, nothing changes.
   */
  const afterLogin = async (profileId: string): Promise<void> => {
    const setup = api.setup;
    if (setup === undefined) return;
    let found;
    try {
      found = await setup.models(profileId);
    } catch (error) {
      say(t('settings.models.failed', { profile: profileId, message: errorText(error) }), 'warn');
      return;
    }
    if (!mounted.current) return;
    if (found.login === 'logged_out') {
      setMode({ kind: 'loginCheck', profileId });
      say(t('setup.models.loggedOut', { profile: profileId }), 'warn');
      return;
    }
    const pick = modelPickStart(found, modelPick);
    if (pick === undefined) {
      if (found.catalog === 'unavailable') {
        say(
          t('settings.models.unavailable', { profile: profileId, reason: found.reason ?? '' }),
          'warn',
        );
      }
      return;
    }
    setMode({ kind: 'models', pick });
  };

  /**
   * Writes the checked models as Executors at once, through a run of the flow `add_account`
   * (N324, part B2): the account, then the step of the Executors with the requests and `exclude`
   * that the choice gives, then the confirmation. [proposta] A run of that flow already open (in the
   * assistant) is left as it is: nothing is written and the message says so. A run this started
   * and that fails is cancelled.
   */
  const registerModels = async (choice: ModelChoice): Promise<void> => {
    const setup = api.setup;
    const profileId = choice.profileId;
    if (setup === undefined) return;
    if (choice.checked.length === 0) {
      say(t('settings.models.none', { profile: profileId }), 'warn');
      return;
    }
    say(t('settings.models.saving', { profile: profileId }), 'ok');
    let runId: string | undefined;
    try {
      runId = (await setup.start('add_account')).id;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'conflict') {
        say(
          t('settings.models.busy', {
            profile: profileId,
            assistant: keyLabel(keymap, 'settings.assistantAccount') ?? '',
          }),
          'warn',
        );
      } else {
        say(
          t('settings.models.writeFailed', { profile: profileId, message: errorText(error) }),
          'error',
        );
      }
      return;
    }
    try {
      const atAccount = await setup.submit(runId, {
        step: 'account',
        input: { profileId },
      });
      const seed = seedOfChoices(atAccount, { [profileId]: choice });
      const atReview = await setup.submit(runId, {
        step: 'executors',
        input: { executors: [...seed.executors], exclude: [...seed.exclude], budgets: [] },
      });
      const plan = atReview.prompt?.step === 'review' ? atReview.prompt.plan : undefined;
      if (plan?.executors.length === 0) {
        await setup.cancel(runId);
        say(t('settings.models.none', { profile: profileId }), 'warn');
        return;
      }
      const done = await setup.confirm(runId);
      const ids = done.result?.executors ?? [];
      say(
        t('settings.models.registered', {
          profile: profileId,
          count: ids.length,
          ids: ids.join(', '),
        }),
        'ok',
      );
      await reload();
    } catch (error) {
      void setup.cancel(runId).catch(() => undefined);
      say(
        t('settings.models.writeFailed', { profile: profileId, message: errorText(error) }),
        'error',
      );
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
    const parsed = parseLimit(prompt.spec, value);
    if (parsed === undefined) {
      say(
        t(
          prompt.spec.kind === 'count' ? 'settings.result.badWhole' : 'settings.result.badDuration',
          {
            key: prompt.spec.key,
            min: prompt.spec.min ?? 0,
          },
        ),
        'warn',
      );
      return;
    }
    void write(limitEdit(prompt.spec.key, parsed));
  };

  const endLogin = (current: Extract<Mode, { kind: 'login' }>): void => {
    // Esc gave up the login: no list comes after it.
    pickAfterLogin.current.delete(current.profileId);
    setMode(IDLE);
    setMessage({ text: t('settings.login.cancelled'), tone: 'warn' });
    void api.cancelLogin(current.profileId).catch((error: unknown) => {
      failed(error);
    });
  };

  /**
   * Opens the form that adds an account (N326) over the clients ready on the machine; with none
   * ready it says so and what opens the assistant, which installs an adapter.
   */
  const openForm = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    try {
      const clients = await api.clients();
      const form = accountFormStart(
        clients.filter((entry) => entry.installed).map((entry) => entry.client),
      );
      if (!mounted.current) return;
      if (form === undefined) {
        say(
          t('settings.result.noClient', {
            assistant: keyLabel(keymap, 'settings.assistantAccount') ?? '',
          }),
          'warn',
        );
        return;
      }
      setMode({ kind: 'form', form });
    } catch (error) {
      failed(error);
    } finally {
      busy.current = false;
    }
  };

  const handleMode = (event: KeyEvent, current: Exclude<Mode, { kind: 'idle' }>): void => {
    if (current.kind === 'models') {
      const step = modelPickKey(current.pick, event.combo);
      if (step.done === undefined) {
        setMode({ kind: 'models', pick: step.pick });
      } else if (step.done === 'confirm') {
        setMode(IDLE);
        void registerModels(choiceOf(step.pick));
      } else {
        setMode(IDLE);
        say(t('settings.models.skipped', { profile: current.pick.profileId }), 'warn');
      }
      return;
    }
    if (current.kind === 'loginCheck') {
      const pressed = (event.combo ?? '').toUpperCase();
      if (pressed === 'L') {
        setMode(IDLE);
        pickAfterLogin.current.add(current.profileId);
        void startLogin(current.profileId);
      } else if (pressed === 'S' || event.combo === 'Esc') {
        setMode(IDLE);
        say(t('setup.models.noLogin', { profile: current.profileId }), 'warn');
      }
      return;
    }
    if (current.kind === 'form') {
      const step = accountFormKey(current.form, event.combo, event.data);
      if (step.done === 'cancel') {
        setMode(IDLE);
      } else if (step.done === 'submit') {
        setMode(IDLE);
        void addProfile(step.body);
      } else {
        setMode({ kind: 'form', form: step.form });
      }
      return;
    }
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
    const data = loadedRef.current;
    const view = data === undefined ? undefined : roleView(data.roles);
    if (id === 'settings.roles' && data !== undefined && view !== undefined) {
      // One line per role: the role the cursor lands on opens its list.
      const next = moveRoleCursor(data.roles, view.open, cursorOf(id), delta);
      setOpenRole(next.open);
      setCursors((now$) => ({ ...now$, [id]: next.at }));
      return;
    }
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
      void openForm();
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
        // An empty list says which keys add an account (N324), not "nothing under the cursor".
        say(
          data.profiles.length === 0
            ? t('settings.result.noAccounts', addKeysOf(keymap))
            : t('settings.result.nothing'),
          'warn',
        );
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
      const item = roleItems(data.roles, roleView(data.roles))[at];
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
      lines.push({
        key: 'e.subs',
        kind: 'row',
        text: t('settings.empty.profiles', addKeysOf(keymap)),
        dim: true,
      });
    }
    // The accounts in columns (the owner's "Seções de hoje, em tabela", 2026-11-26): the account,
    // its kind, the used percent of each window (`—` with no reading) and its state.
    const quotaOf = (entry: (typeof loaded.profiles)[number]): ApiQuotaStatus | null =>
      quotas[entry.profile.id] ?? entry.quota;
    const windows = windowColumns(loaded.profiles.map(quotaOf));
    const subs = alignColumns(
      [
        [
          t('settings.table.account'),
          t('settings.table.kind'),
          ...windows,
          t('settings.table.state'),
        ],
        ...loaded.profiles.map((entry) => {
          const quota = quotaOf(entry);
          const line = quotaLine(quota, clock);
          const state: string[] = [];
          if (entry.profile.state !== 'active')
            state.push(t(`settings.profile.${entry.profile.state}`));
          if (entry.profile.kind === 'api' && !entry.hasSecret)
            state.push(t('settings.profile.noSecret'));
          state.push(t(`settings.quota.${line.state}`));
          if (line.resetsIn !== undefined) {
            state.push(t('settings.profile.resets', { time: formatSpan(line.resetsIn) }));
          }
          return [
            entry.profile.id,
            t(`accountForm.kind.${entry.profile.kind}`),
            ...windows.map((name) => windowCell(quota, name)),
            state.join(' · '),
          ];
        }),
      ],
      2,
      width - 1,
    );
    if (loaded.profiles.length > 0) {
      lines.push({
        key: 's.head',
        kind: 'row',
        section: 'settings.subscriptions',
        text: subs[0] ?? '',
        dim: true,
      });
    }
    loaded.profiles.forEach((entry, index) => {
      const line = quotaLine(quotaOf(entry), clock);
      lines.push({
        key: `s.${entry.profile.id}`,
        kind: 'row',
        section: 'settings.subscriptions',
        text: subs[index + 1] ?? entry.profile.id,
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
    const execs = alignColumns(
      [
        [t('settings.table.executor'), t('settings.table.roles')],
        ...loaded.executors.map((executor) => [
          executor.id,
          executor.roles.length === 0 ? t('settings.executor.noRoles') : executor.roles.join(', '),
          executor.validity === 'invalid'
            ? t('settings.executor.invalid', { reason: executor.invalidReason ?? '' })
            : '',
        ]),
      ],
      2,
      width - 1,
    );
    if (loaded.executors.length > 0) {
      lines.push({
        key: 'x.head',
        kind: 'row',
        section: 'settings.executors',
        text: execs[0] ?? '',
        dim: true,
      });
    }
    loaded.executors.forEach((executor, index) => {
      lines.push({
        key: `x.${executor.id}`,
        kind: 'row',
        section: 'settings.executors',
        text: execs[index + 1] ?? executor.id,
        color: executor.validity === 'invalid' ? TOKEN.warn : undefined,
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
    const view = roleView(loaded.roles);
    // One line per role (`ui.settingsTab.roles: line`): the role, its Executors cut to the room
    // left, and what happens when they run out.
    const roleLine = new Map<string, string>();
    if (view !== undefined && loaded.roles.roles.length > 0) {
      const ruleOf = (rule: 'next' | 'wait'): string => `→ ${t(`settings.role.${rule}`)}`;
      const head = [
        t('settings.table.role'),
        t('settings.table.executors'),
        t('settings.table.whenExhausted'),
      ];
      const roleWidth = Math.max(
        cellWidth(head[0] ?? ''),
        ...loaded.roles.roles.map((role) => cellWidth(role.role)),
      );
      const ruleWidth = Math.max(
        cellWidth(head[2] ?? ''),
        ...loaded.roles.roles.map((role) => cellWidth(ruleOf(role.whenExhausted))),
      );
      const room = Math.max(8, width - 2 - roleWidth - ruleWidth - 4);
      const cut = (text: string): string =>
        cellWidth(text) <= room ? text : `${clip(text, room - 1)}…`;
      const rows = alignColumns(
        [
          head,
          ...loaded.roles.roles.map((role) => [
            role.role,
            cut(
              role.executors.length === 0
                ? t('settings.role.none')
                : role.executors.map((executor) => executor.id).join(', '),
            ),
            ruleOf(role.whenExhausted),
          ]),
        ],
        2,
        width - 1,
      );
      lines.push({
        key: 'r.head',
        kind: 'row',
        section: 'settings.roles',
        text: rows[0] ?? '',
        dim: true,
      });
      loaded.roles.roles.forEach((role, index) => {
        roleLine.set(role.role, rows[index + 1] ?? role.role);
      });
    }
    roleItems(loaded.roles, view).forEach((item, index) => {
      const role = loaded.roles.roles.find((candidate) => candidate.role === item.role);
      if (role === undefined) return;
      const selected = onCursor('settings.roles', index);
      if (item.kind === 'rule') {
        const blocked = role.executors.some((executor) => executor.blockedBy !== null);
        lines.push({
          key: `r.${item.role}`,
          kind: 'row',
          section: 'settings.roles',
          text:
            roleLine.get(item.role) ??
            `${item.role}  ${t('settings.role.rule', { rule: t(`settings.role.${role.whenExhausted}`) })}`,
          color: view !== undefined && blocked ? TOKEN.warn : undefined,
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
        text: `${view === undefined ? '  ' : '    '}${String(item.index + 1)}. ${executor.id}${blocked}`,
        color: executor.blockedBy === null ? undefined : TOKEN.warn,
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
    const limitRows = alignColumns(
      LIMIT_KEYS.map((spec) => [spec.key, `= ${limitValueText(spec, limits[spec.key])}`]),
      1,
    );
    LIMIT_KEYS.forEach((spec, index) => {
      lines.push({
        key: `l.${spec.key}`,
        kind: 'row',
        section: 'settings.limits',
        text: limitRows[index] ?? spec.key,
        selected: onCursor('settings.limits', index),
      });
    });
  }

  // The folded sections keep their header only.
  // Limits starts folded (`ui.settingsTab.limits`); Enter flips the default, as it always did.
  const sectionControl = {
    ...content.sections,
    folded: settingsFolded(content.sections.folded, settings.settingsTab.limits),
  };
  const visible = lines.filter(
    (line) => line.kind === 'header' || !sectionControl.folded.has(line.section ?? ''),
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
    head.push({ key: 'p.label', kind: 'row', text: mode.label, color: TOKEN.accent });
    head.push({
      key: 'p.value',
      kind: 'row',
      text: `> ${mode.secret ? '•'.repeat(Array.from(mode.value).length) : mode.value}▏`,
    });
    head.push({ key: 'p.hint', kind: 'row', text: t('settings.prompt.hintEnter'), dim: true });
  } else if (mode.kind === 'form') {
    const login = addLoginModeOf(loaded?.config.config ?? {}) !== 'off';
    for (const line of accountFormLines(mode.form, t, { login })) {
      head.push({
        key: line.key,
        kind: 'row',
        text: line.text,
        color:
          line.tone === 'accent' ? TOKEN.accent : line.tone === 'warn' ? TOKEN.warn : undefined,
        dim: line.dim === true,
        selected: line.selected === true,
      });
    }
  } else if (mode.kind === 'models') {
    for (const line of modelPickLines(mode.pick, t, 'settings.models.keys')) {
      head.push({
        key: line.key,
        kind: 'row',
        text: line.text,
        color: line.tone === 'accent' ? TOKEN.accent : undefined,
        dim: line.dim === true,
        selected: line.selected === true,
      });
    }
  } else if (mode.kind === 'loginCheck') {
    head.push({
      key: 'k.keys',
      kind: 'row',
      text: t('setup.models.loginCheckKeys'),
      color: TOKEN.accent,
    });
  } else if (mode.kind === 'confirm') {
    head.push({ key: 'c.q', kind: 'row', text: mode.question, color: TOKEN.warn });
    head.push({ key: 'c.hint', kind: 'row', text: t('settings.prompt.hintConfirm'), dim: true });
  } else if (mode.kind === 'login') {
    head.push({
      key: 'g.title',
      kind: 'row',
      text: t('settings.login.title', { profile: mode.profileId }),
      color: TOKEN.accent,
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
        color: TOKEN.accent,
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
        color: TOKEN.warn,
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
      color: loadError === undefined ? undefined : TOKEN.error,
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
          control={sectionControl}
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
    // The leading spaces are the indent (a role's list under its line): kept on every piece.
    const text = line.text ?? '';
    const indent = /^ */.exec(text)?.[0] ?? '';
    const pieces = wrapText(text.slice(indent.length), Math.max(1, width - 1 - indent.length)).map(
      (piece) => indent + piece,
    );
    pieces.forEach((piece, index) => {
      wrapped.push(
        <Text
          key={`${line.key}.${String(index)}`}
          wrap="truncate"
          dimColor={line.dim === true}
          {...paint(line.color, line.selected === true ? TOKEN.selected : undefined)}
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
