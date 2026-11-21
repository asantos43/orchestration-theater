// SPDX-License-Identifier: MPL-2.0
import type { ApiOrder } from '@otheater/protocol';
import { Box, Text } from 'ink';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { keyLabel, pairLabel } from '../../keys/labels.js';
import { useRawKeys, type KeyEvent } from '../../keys/use-keymap.js';
import { fit, fitRight, wrapText } from '../../layout/text.js';
import { Section } from '../../layout/section.js';
import { useTabHost } from '../../layout/tab-host.js';
import type { TabContentProps } from '../../layout/tab-types.js';
import { COLOR, paint } from '../../layout/theme.js';
import { useRenderControl } from '../../render-control.js';
import { useStoreValue } from '../../use-store-value.js';
import {
  choiceOptions,
  editForm,
  fieldsOf,
  isChoice,
  openForm,
  problemOf,
  requestOf,
  textOf,
  type FieldId,
  type FormAction,
  type FormState,
  type OrderRequest,
} from './form.js';
import { splitAtCursor } from './line-input.js';
import {
  ORDER_SECTIONS,
  dateText,
  deadlineOf,
  firstLine,
  groupOrders,
  sectionId,
  spanText,
  timelineBar,
  visibleOrderIds,
  type OrderGroup,
} from './view.js';

/**
 * The tab Directives (architecture 5.17): the Producer's orders in force, scheduled and ended, by
 * scope, with the timeline of the validity and the deadlines, and the four things a Producer does
 * with an order: give one, extend it, suspend it in a scenario, revoke it. [proposta]
 *
 * What it shows comes from the orders store of the client alone, which the events `directive.*`
 * move. An action goes to the daemon (`/v1/orders`) and the tab changes when the event comes back:
 * it never reads the orders again after an action.
 */

/** How often the deadlines are drawn again against the clock. */
const CLOCK_MS = 30_000;
const BAR_CELLS = 16;

type Tone = 'info' | 'ok' | 'error';
interface Message {
  readonly tone: Tone;
  readonly text: string;
}

const TONE_COLOR: Readonly<Record<Tone, string | undefined>> = {
  info: undefined,
  ok: COLOR.ok,
  error: COLOR.error,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DirectivesTab(props: TabContentProps): ReactNode {
  const { stores, keymap, capture } = useTabHost();
  const { t } = useTranslation();
  const { afterKey } = useRenderControl();
  const { width } = props;

  const byId = useStoreValue(stores.orders, (state) => state.byId);
  const expiring = useStoreValue(stores.orders, (state) => state.expiring);
  const scenarios = useStoreValue(stores.scenarios, (state) => state.byId);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const scenarioName = (id: string): string => scenarios[id]?.name ?? id;
  const sections = useMemo(
    () => groupOrders(Object.values(byId), (id) => scenarios[id]?.name ?? id),
    [byId, scenarios],
  );
  const visible = useMemo(
    () => visibleOrderIds(sections, props.sections.folded),
    [sections, props.sections.folded],
  );

  // The selection is an id; when the order is not on the screen (it moved to another section, the
  // section is folded) the first one on the screen is the selected one.
  const [pickedId, setPickedId] = useState<string | undefined>(undefined);
  const selectedId = pickedId !== undefined && visible.includes(pickedId) ? pickedId : visible[0];
  const selected = selectedId === undefined ? undefined : byId[selectedId];

  const [form, setFormState] = useState<FormState | undefined>(undefined);
  const formRef = useRef<FormState | undefined>(undefined);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const sending = useRef(false);
  const mounted = useRef(true);

  const setForm = (next: FormState | undefined): void => {
    formRef.current = next;
    setFormState(next);
  };

  // The keyboard goes back to the screen only after the key that closed the form has been seen by
  // everyone who listens (the `Shell` too), so Enter or Esc does not also act on the panel.
  const releaseKeyboard = (): void => {
    queueMicrotask(() => {
      if (formRef.current === undefined) capture.current = false;
    });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      formRef.current = undefined;
      capture.current = false;
    };
  }, [capture]);

  const closeForm = (): void => {
    setForm(undefined);
    releaseKeyboard();
  };

  const open = (action: FormAction): void => {
    const activeScenarios = Object.values(scenarios)
      .filter((scenario) => scenario.state === 'active')
      .map((scenario) => ({ id: scenario.id, name: scenario.name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (action !== 'new') {
      if (selected === undefined) {
        setMessage({ tone: 'error', text: t('directives.status.needOrder') });
        return;
      }
      if (action !== 'suspend' && selected.state === 'revoked') {
        setMessage({ tone: 'error', text: t('directives.status.alreadyRevoked') });
        return;
      }
      if (action === 'suspend') {
        if (selected.scope !== 'global' || selected.kind === 'suspension') {
          setMessage({ tone: 'error', text: t('directives.status.onlyGlobal') });
          return;
        }
        if (activeScenarios.length === 0) {
          setMessage({ tone: 'error', text: t('directives.status.noScenario') });
          return;
        }
      }
    }
    setMessage(undefined);
    capture.current = true;
    setForm(
      openForm(action, {
        scenarios: activeScenarios,
        ...(action === 'new' || selected === undefined
          ? {}
          : { orderId: selected.id, subject: `${selected.id} ${firstLine(selected.text)}` }),
      }),
    );
  };

  const run = async (
    request: OrderRequest,
    control: { readonly idempotencyKey: string },
  ): Promise<ApiOrder> => {
    const client = stores.client;
    switch (request.action) {
      case 'new':
        return (await client.createOrder(request.body, control)).order;
      case 'extend':
        return (await client.extendOrder(request.orderId, request.validity, control)).order;
      case 'suspend':
        return (await client.suspendOrder(request.orderId, request.body, control)).order;
      case 'revoke':
        return (await client.revokeOrder(request.orderId, request.reason, control)).order;
    }
  };

  const send = (current: FormState): void => {
    if (sending.current) return;
    const problem = problemOf(current);
    if (problem !== undefined) {
      setMessage({ tone: 'error', text: t(`directives.form.problem.${problem}`) });
      return;
    }
    const request = requestOf(current);
    if (request === undefined) return;
    sending.current = true;
    setMessage({ tone: 'info', text: t('directives.status.sending') });
    // A new key for each attempt the person makes: a retry after a failure is a new command.
    const control = { idempotencyKey: crypto.randomUUID() };
    run(request, control)
      .then((order) => {
        if (!mounted.current) return;
        // Nothing is read again: the event `directive.*` of this command moves the store.
        closeForm();
        setMessage({
          tone: 'ok',
          text: t(`directives.status.${doneKey(request)}`, { id: order.id }),
        });
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setMessage({
          tone: 'error',
          text: t('directives.status.failed', { message: errorText(error) }),
        });
      })
      .finally(() => {
        sending.current = false;
      });
  };

  const onKey = (event: KeyEvent): void => {
    const current = formRef.current;
    if (current !== undefined) {
      if (event.combo === 'Esc') {
        setMessage(undefined);
        closeForm();
      } else if (event.combo === 'Enter') {
        send(current);
      } else {
        const next = editForm(current, event);
        if (next !== current) {
          setForm(next);
          setMessage(undefined);
        }
      }
      afterKey();
      return;
    }
    if (event.combo === undefined) return;
    switch (keymap.match(event.combo, ['directives'])) {
      case 'directives.new':
        open('new');
        break;
      case 'directives.extend':
        open('extend');
        break;
      case 'directives.suspend':
        open('suspend');
        break;
      case 'directives.revoke':
        open('revoke');
        break;
      case 'directives.previous':
      case 'directives.next': {
        const delta = keymap.match(event.combo, ['directives']) === 'directives.next' ? 1 : -1;
        const at = selectedId === undefined ? -1 : visible.indexOf(selectedId);
        const target = visible[Math.min(visible.length - 1, Math.max(0, at + delta))];
        if (target !== undefined) setPickedId(target);
        break;
      }
      default:
        return;
    }
    afterKey();
  };
  useRawKeys(onKey, { isActive: props.focused });

  const total = Object.keys(byId).length;
  const hint = t('directives.tab.hint', {
    new: keyLabel(keymap, 'directives.new') ?? '',
    extend: keyLabel(keymap, 'directives.extend') ?? '',
    suspend: keyLabel(keymap, 'directives.suspend') ?? '',
    revoke: keyLabel(keymap, 'directives.revoke') ?? '',
    move: pairLabel(keyLabel(keymap, 'directives.previous'), keyLabel(keymap, 'directives.next')),
  });

  const renderOrder = (order: ApiOrder): ReactNode => {
    const isSelected = order.id === selectedId;
    const notice = expiring[order.id];
    const deadline = deadlineOf(order, now);
    const deadlineText =
      notice !== undefined && order.state === 'active'
        ? t('directives.tab.deadline.expiring', { span: spanText(notice.endsAt - now) })
        : t(`directives.tab.deadline.${deadline.kind}`, {
            span: 'span' in deadline ? deadline.span : '',
          });
    const head = `${isSelected ? '›' : ' '} ${order.id} [${t(`directives.tab.kind.${order.kind}`)}] ${firstLine(order.text)}`;
    const headWidth = Math.max(1, width - deadlineText.length - 3);
    const ended = order.state === 'expired' || order.state === 'revoked';
    const warn = notice !== undefined && order.state === 'active';
    const until =
      order.endsAt === null
        ? t('directives.tab.timeline.open')
        : dateText(order.endsAt, order.timezone);
    const line = `    ${dateText(order.startsAt, order.timezone)} ${timelineBar(order, now, BAR_CELLS)} ${until}`;
    return (
      <Box key={order.id} flexDirection="column" width={width}>
        <Text
          bold={isSelected}
          dimColor={ended && !isSelected}
          {...paint(isSelected ? COLOR.accent : undefined)}
          wrap="truncate"
        >
          {`${fit(head, headWidth)} ${fitRight(deadlineText, Math.min(deadlineText.length, width - 2))}`}
        </Text>
        <Text dimColor={!warn} {...paint(warn ? COLOR.warn : undefined)} wrap="truncate">
          {fit(line, width)}
        </Text>
        {isSelected && renderDetail(order)}
      </Box>
    );
  };

  const renderDetail = (order: ApiOrder): ReactNode => {
    const lines: string[] = [];
    if (order.text.includes('\n') || firstLine(order.text).length + 8 > width) {
      lines.push(...wrapText(order.text, Math.max(10, width - 6)));
    }
    if (order.kind === 'rule' && order.ruleKey !== null) {
      lines.push(
        t('directives.tab.detail.rule', {
          key: order.ruleKey,
          value: JSON.stringify(order.ruleValue),
        }),
      );
    }
    if (order.suspendsId !== null) {
      lines.push(t('directives.tab.detail.suspends', { id: order.suspendsId }));
    }
    if (order.replacesId !== null) {
      lines.push(t('directives.tab.detail.replaces', { id: order.replacesId }));
    }
    lines.push(
      t('directives.tab.detail.roles', {
        roles:
          order.roles.length === 0 ? t('directives.tab.detail.allRoles') : order.roles.join(', '),
      }),
    );
    if (order.revokeReason !== null) {
      lines.push(t('directives.tab.detail.reason', { reason: order.revokeReason }));
    }
    lines.push(
      `${t('directives.tab.detail.zone', { zone: order.timezone })}  ${t('directives.tab.detail.origin', { origin: order.origin })}`,
    );
    return (
      <Box flexDirection="column" width={width}>
        {lines.map((line, index) => (
          <Text key={index} dimColor wrap="truncate">
            {fit(`      ${line}`, width)}
          </Text>
        ))}
      </Box>
    );
  };

  const renderGroup = (group: OrderGroup): ReactNode => (
    <Box key={group.scenarioId ?? '*'} flexDirection="column" width={width}>
      <Text bold wrap="truncate">
        {fit(
          `  ${
            group.scenarioId === null
              ? t('directives.tab.scope.global')
              : t('directives.tab.scope.local', { name: scenarioName(group.scenarioId) })
          }`,
          width,
        )}
      </Text>
      {group.orders.map(renderOrder)}
    </Box>
  );

  const fieldValue = (current: FormState, field: FieldId): ReactNode => {
    if (isChoice(field)) {
      const value = current.choices[field] ?? '';
      const options = choiceOptions(current, field);
      const name =
        field === 'scenario'
          ? (scenarios[value]?.name ?? t('directives.form.noScenario'))
          : t(`directives.form.choice.${value === '' ? 'no' : value}`);
      return options.length > 1 ? `‹ ${name} ›` : name;
    }
    const line = textOf(current, field);
    if (current.active !== field) return line.value;
    const parts = splitAtCursor(line);
    return (
      <>
        {parts.before}
        <Text inverse>{parts.under}</Text>
        {parts.after}
      </>
    );
  };

  const renderForm = (current: FormState): ReactNode => {
    const fields = fieldsOf(current);
    const subject = current.subject ?? '';
    return (
      <Box flexDirection="column" width={width} marginBottom={1}>
        <Text bold {...paint(COLOR.accent)} wrap="truncate">
          {fit(t(`directives.form.title.${current.action}`, { subject }), width)}
        </Text>
        {fields.map((field) => (
          <Text
            key={field}
            bold={field === current.active}
            {...paint(field === current.active ? COLOR.accent : undefined)}
            wrap="truncate"
          >
            {`${field === current.active ? '›' : ' '} ${t(`directives.form.field.${field}`)}: `}
            {fieldValue(current, field)}
          </Text>
        ))}
        <Text dimColor wrap="truncate">
          {fit(
            t(isChoice(current.active) ? 'directives.form.hintChoice' : 'directives.form.hint'),
            width,
          )}
        </Text>
      </Box>
    );
  };

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
      {form !== undefined && renderForm(form)}
      {total === 0 && form === undefined && (
        <Text dimColor wrap="truncate">
          {fit(t('directives.tab.empty', { key: keyLabel(keymap, 'directives.new') ?? '' }), width)}
        </Text>
      )}
      {ORDER_SECTIONS.map((section) => {
        const groups = sections[section];
        const count = groups.reduce((sum, group) => sum + group.orders.length, 0);
        return (
          <Section
            key={section}
            id={sectionId(section)}
            title={t(`directives.tab.sections.${section}`)}
            right={String(count)}
            width={width}
            control={props.sections}
          >
            {count === 0 ? (
              <Text dimColor wrap="truncate">
                {fit(`  ${t('directives.tab.none')}`, width)}
              </Text>
            ) : (
              groups.map(renderGroup)
            )}
          </Section>
        );
      })}
    </Box>
  );
}

/** The key of the message that says what was done. */
function doneKey(request: OrderRequest): string {
  switch (request.action) {
    case 'new':
      return 'created';
    case 'extend':
      return 'extended';
    case 'suspend':
      return 'suspended';
    case 'revoke':
      return 'revoked';
  }
}
