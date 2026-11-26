// SPDX-License-Identifier: MPL-2.0
import {
  actorControls,
  formatRemaining,
  playControls,
  type ActorRow,
  type DemandRow,
  type EventRow,
  type PipelineView,
} from '@otheater/client';
import { Box } from 'ink';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../../layout/themed-text.js';
import { keyLabel } from '../../keys/labels.js';
import { useRawKeys, type KeyEvent } from '../../keys/use-keymap.js';
import { useTabHost } from '../../layout/tab-host.js';
import type { TabContentProps, TabDefinition } from '../../layout/tab-types.js';
import type { QuotaRow } from '../../layout/scenario-rows.js';
import { fillBar, noReadingKey } from '../../layout/scenario-rows.js';
import { useDensity } from '../../layout/density-context.js';
import { Section } from '../../layout/section.js';
import { cellWidth, fit, wrapText } from '../../layout/text.js';
import { TOKEN, paint } from '../../layout/theme.js';
import { useStoreValue } from '../../use-store-value.js';
import { formatClock, useNow } from '../use-now.js';
import { useControlRunner, type ControlKind, type ControlRequest } from './use-controls.js';
import { useOverviewData } from './use-overview.js';

/** The ids of the sections, top to bottom (the `LayoutStore` keeps which are folded). */
export const OVERVIEW_SECTIONS = [
  'overview.pipeline',
  'overview.demands',
  'overview.actors',
  'overview.events',
  'overview.quota',
] as const;

const OVERVIEW_ACTIONS = [
  'overview.pausePlay',
  'overview.resumePlay',
  'overview.nextActor',
  'overview.pauseActor',
  'overview.resumeActor',
] as const;

const DEMAND_MARK: Readonly<Record<DemandRow['state'], { glyph: string; color?: string }>> = {
  approved: { glyph: '✓', color: TOKEN.ok },
  running: { glyph: '●', color: TOKEN.accent },
  in_review: { glyph: '◉', color: TOKEN.accent },
  ready: { glyph: '○' },
  pending: { glyph: '·' },
  failed: { glyph: '✗', color: TOKEN.error },
  blocked: { glyph: '⊘', color: TOKEN.warn },
  cancelled: { glyph: '–' },
};

function quotaColor(row: QuotaRow): string {
  if (row.state === 'exhausted') return TOKEN.error;
  if (row.state === 'near_limit') return TOKEN.warn;
  return TOKEN.ok;
}

// ---- the sections ---------------------------------------------------------------------------

function PipelineLines(props: {
  readonly pipeline: PipelineView;
  readonly need: string;
  readonly width: number;
}): ReactNode {
  const { t } = useTranslation();
  const { pipeline, width } = props;
  // The steps flow into lines of the width of the panel; a step is never cut in two.
  const lines: { text: string; mark: PipelineView['steps'][number]['mark']; id: string }[][] = [[]];
  let used = 0;
  for (const step of pipeline.steps) {
    const glyph = step.mark === 'done' ? '✓' : step.mark === 'current' ? '●' : '○';
    const text = `${glyph} ${t(`overview.state.${step.state}`)}`;
    const size = cellWidth(text) + 2;
    const line = lines[lines.length - 1];
    if (line === undefined) break;
    if (used > 0 && used + size > width) {
      lines.push([{ text, mark: step.mark, id: step.state }]);
      used = size;
    } else {
      line.push({ text, mark: step.mark, id: step.state });
      used += size;
    }
  }
  return (
    <>
      <Text dimColor wrap="truncate">
        {fit(t('overview.pipeline.need', { need: props.need }), width)}
      </Text>
      {lines.map((line) => (
        <Text key={line[0]?.id ?? 'empty'} wrap="truncate">
          {line.map((step, index) => (
            <Text
              key={step.id}
              bold={step.mark === 'current'}
              dimColor={step.mark === 'todo'}
              {...paint(
                step.mark === 'done'
                  ? TOKEN.ok
                  : step.mark === 'current'
                    ? TOKEN.accent
                    : undefined,
              )}
            >
              {index === 0 ? '' : '  '}
              {step.text}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

function DemandLine(props: { readonly row: DemandRow; readonly width: number }): ReactNode {
  const { t } = useTranslation();
  const { row, width } = props;
  const mark = DEMAND_MARK[row.state];
  const state = `${t(`overview.demands.state.${row.state}`)}${row.waiting ? ` (${t('overview.demands.waiting')})` : ''}`;
  const deps = row.dependsOn.length === 0 ? '' : ` ← ${row.dependsOn.join(', ')}`;
  const left = fit(`${row.id}${deps}  ${row.title}`, Math.max(1, width - 2 - cellWidth(state) - 1));
  return (
    <Text wrap="truncate">
      <Text {...paint(mark.color)} dimColor={mark.color === undefined}>
        {mark.glyph}
      </Text>{' '}
      {left} <Text dimColor>{state}</Text>
    </Text>
  );
}

function ActorLine(props: {
  readonly row: ActorRow;
  readonly selected: boolean;
  readonly width: number;
}): ReactNode {
  const { t } = useTranslation();
  const { row, width } = props;
  let right: string;
  let late = false;
  if (row.paused !== undefined) right = t('overview.actors.paused');
  else if (row.remainingMs === undefined) right = '—';
  else {
    late = row.remainingMs < 0;
    right = t(late ? 'overview.actors.over' : 'overview.actors.left', {
      time: formatRemaining(Math.abs(row.remainingMs)),
    });
  }
  const demand = row.demandId === undefined ? '' : ` · ${row.demandId}`;
  const left = fit(
    `${row.client}/${row.profile} ${row.model}${demand}`,
    Math.max(1, width - 4 - cellWidth(right) - 1),
  );
  return (
    <Text wrap="truncate" {...paint(undefined, props.selected ? TOKEN.selected : undefined)}>
      <Text color={TOKEN.accent}>{props.selected ? '▸ ' : '  '}</Text>
      <Text {...paint(row.paused === undefined ? TOKEN.accent : TOKEN.warn)}>
        {row.paused === undefined ? '●' : '‖'}
      </Text>{' '}
      {left} <Text {...paint(late ? TOKEN.warn : undefined)}>{right}</Text>
    </Text>
  );
}

function EventLine(props: { readonly row: EventRow; readonly width: number }): ReactNode {
  const { row, width } = props;
  const text = `${row.type}${row.detail === undefined ? '' : ` ${row.detail}`}`;
  return (
    <Text wrap="truncate">
      <Text dimColor>{formatClock(row.timestamp)}</Text> {fit(text, Math.max(1, width - 9))}
    </Text>
  );
}

function QuotaLine(props: { readonly row: QuotaRow; readonly width: number }): ReactNode {
  const { t } = useTranslation();
  const { row, width } = props;
  const color = quotaColor(row);
  const values =
    row.fiveHour === undefined && row.week === undefined
      ? t(`layout.sidebar.${noReadingKey(row.profile)}`)
      : `${t('layout.sidebar.fiveHour')} ${row.fiveHour === undefined ? '—' : `${String(row.fiveHour)}%`} · ${t('layout.sidebar.week')} ${row.week === undefined ? '—' : `${String(row.week)}%`}`;
  const bar = row.fiveHour === undefined ? '' : ` ${fillBar(8, row.fiveHour)}`;
  const name = fit(row.profile, Math.max(1, width - cellWidth(values) - cellWidth(bar) - 1));
  return (
    <Text wrap="truncate">
      {name}
      <Text color={color}>{bar}</Text>{' '}
      <Text {...paint(row.state === 'ok' ? undefined : color)}>{values}</Text>
    </Text>
  );
}

// ---- the tab --------------------------------------------------------------------------------

function OverviewTab(props: TabContentProps): ReactNode {
  const { t } = useTranslation();
  const host = useTabHost();
  const spaced = useDensity().sections;
  const { width, sections, scenarioId, focused } = props;
  const settings = host.settings.overview;
  const [actorKey, setActorKey] = useState<string | undefined>();
  // The clock ticks only while an Actor is on the list: that is the one thing that counts time.
  const hasActors = useStoreValue(host.stores.activity, (s) => Object.keys(s.actors).length > 0);
  const now = useNow(host.now, hasActors);
  const data = useOverviewData(host.stores, scenarioId, settings, now, host.settings.quota.show);
  const runner = useControlRunner(host.client, settings.confirm, scenarioId);

  const selected = data.actors.find((row) => row.key === actorKey) ?? data.actors[0];
  const selectedActivity = selected === undefined ? undefined : data.activity[selected.key];
  const playOn = playControls(data.play, data.pausedPlays);
  const actorOn = actorControls(selectedActivity);
  const actorName = selected === undefined ? '' : `${selected.client}/${selected.profile}`;

  const ask = (kind: ControlKind): void => {
    let request: ControlRequest | undefined;
    if (kind === 'pausePlay' || kind === 'resumePlay') {
      if (data.play === undefined || !(kind === 'pausePlay' ? playOn.pause : playOn.resume)) return;
      request = {
        kind,
        target: { kind: 'play', playId: data.play.id },
        action: kind === 'pausePlay' ? 'pause' : 'resume',
        subject: data.play.need,
      };
    } else {
      const attemptId = selected?.attemptId;
      if (attemptId === undefined || !(kind === 'pauseActor' ? actorOn.pause : actorOn.resume))
        return;
      request = {
        kind,
        target: { kind: 'actor', attemptId },
        action: kind === 'pauseActor' ? 'pause' : 'resume',
        subject: actorName,
      };
    }
    runner.request(request);
  };

  useRawKeys(
    (event: KeyEvent) => {
      if (runner.pending !== undefined) {
        // The question is open: `y` answers it and any other key withdraws it.
        if (event.data === 'y' || event.data === 'Y') runner.confirm();
        else runner.cancel();
        return;
      }
      if (event.combo === undefined) return;
      const id = host.keymap.match(event.combo, ['overview']);
      if (id === undefined || !(OVERVIEW_ACTIONS as readonly string[]).includes(id)) return;
      switch (id) {
        case 'overview.pausePlay':
          ask('pausePlay');
          return;
        case 'overview.resumePlay':
          ask('resumePlay');
          return;
        case 'overview.pauseActor':
          ask('pauseActor');
          return;
        case 'overview.resumeActor':
          ask('resumeActor');
          return;
        case 'overview.nextActor': {
          if (data.actors.length === 0) return;
          const at = data.actors.findIndex((row) => row.key === selected?.key);
          setActorKey(data.actors[(at + 1) % data.actors.length]?.key);
          return;
        }
        default:
          return;
      }
    },
    { isActive: focused && host.client !== undefined },
  );

  if (scenarioId === undefined) {
    return (
      <Text dimColor wrap="truncate">
        {t('overview.noScenario')}
      </Text>
    );
  }

  // The line at the top: the question, the answer of the last call, or the keys that work now.
  let notice: ReactNode;
  if (runner.pending !== undefined) {
    notice = wrapText(
      t(`overview.confirm.${runner.pending.kind}`, { subject: runner.pending.subject }),
      width,
    ).map((line) => (
      <Text key={line} color={TOKEN.warn} bold wrap="truncate">
        {line}
      </Text>
    ));
  } else if (runner.busy) {
    notice = (
      <Text dimColor wrap="truncate">
        {t('overview.busy')}
      </Text>
    );
  } else if (runner.outcome !== undefined) {
    const { request, result } = runner.outcome;
    const text = result.ok
      ? t(`overview.done.${request.kind}`, { subject: request.subject })
      : t(`overview.failed.${result.code}`, {
          defaultValue: t('overview.failed.other', { code: result.code }),
        });
    notice = (
      <Text color={result.ok ? TOKEN.ok : TOKEN.error} wrap="truncate">
        {fit(text, width)}
      </Text>
    );
  } else if (host.client !== undefined) {
    const hints: string[] = [];
    const add = (action: (typeof OVERVIEW_ACTIONS)[number], on: boolean, text: string): void => {
      const label = keyLabel(host.keymap, action);
      if (on && label !== undefined) hints.push(`${label} ${text}`);
    };
    add('overview.pausePlay', playOn.pause, t('overview.hint.pausePlay'));
    add('overview.resumePlay', playOn.resume, t('overview.hint.resumePlay'));
    add('overview.nextActor', data.actors.length > 1, t('overview.hint.nextActor'));
    add('overview.pauseActor', actorOn.pause, t('overview.hint.pauseActor'));
    add('overview.resumeActor', actorOn.resume, t('overview.hint.resumeActor'));
    notice = wrapText(hints.join(' · '), width).map((line) => (
      <Text key={line} dimColor wrap="truncate">
        {line}
      </Text>
    ));
  }
  // The mockup's sections: the content indented by 2 and a blank row between them.
  const indent = spaced ? 2 : 0;
  const gap = spaced ? 1 : 0;
  const inner = Math.max(1, width - indent);
  const { play, pipeline } = data;
  const approved = data.demands.filter((row) => row.state === 'approved').length;
  return (
    <Box flexDirection="column" width={width}>
      {notice}
      <Section
        id="overview.pipeline"
        title={t('overview.pipeline.title')}
        right={pipeline?.paused === true ? t('overview.paused') : undefined}
        width={width}
        control={sections}
        indent={indent}
        gap={gap}
      >
        {play === undefined || pipeline === undefined ? (
          <Text dimColor wrap="truncate">
            {t('overview.noPlay')}
          </Text>
        ) : (
          <PipelineLines pipeline={pipeline} need={play.need} width={inner} />
        )}
      </Section>
      <Section
        id="overview.demands"
        title={t('overview.demands.title')}
        right={
          data.demands.length === 0
            ? undefined
            : `${String(approved)}/${String(data.demands.length)}`
        }
        width={width}
        control={sections}
        indent={indent}
        gap={gap}
      >
        {data.demands.length === 0 ? (
          <Text dimColor wrap="truncate">
            {t('overview.demands.empty')}
          </Text>
        ) : (
          data.demands.map((row) => <DemandLine key={row.id} row={row} width={inner} />)
        )}
      </Section>
      <Section
        id="overview.actors"
        title={t('overview.actors.title')}
        right={data.actors.length === 0 ? undefined : String(data.actors.length)}
        width={width}
        control={sections}
        indent={indent}
        gap={gap}
      >
        {data.actors.length === 0 ? (
          <Text dimColor wrap="truncate">
            {t('overview.actors.empty')}
          </Text>
        ) : (
          data.actors.map((row) => (
            <ActorLine key={row.key} row={row} selected={row.key === selected?.key} width={inner} />
          ))
        )}
      </Section>
      <Section
        id="overview.events"
        title={t('overview.events.title')}
        width={width}
        control={sections}
        indent={indent}
        gap={gap}
      >
        {data.events.length === 0 ? (
          <Text dimColor wrap="truncate">
            {t('overview.events.empty')}
          </Text>
        ) : (
          data.events.map((row) => <EventLine key={row.id} row={row} width={inner} />)
        )}
      </Section>
      <Section
        id="overview.quota"
        title={t('overview.quota.title')}
        width={width}
        control={sections}
        indent={indent}
      >
        {data.quotas.length === 0 ? (
          <Text dimColor wrap="truncate">
            {t('overview.quota.empty')}
          </Text>
        ) : (
          data.quotas.map((row) => <QuotaLine key={row.profile} row={row} width={inner} />)
        )}
      </Section>
    </Box>
  );
}

/** The Overview tab: the pipeline, the demands, the Actors in flight, the recent events and the quota. */
export const overviewTab: TabDefinition = {
  sections: OVERVIEW_SECTIONS,
  render: (props) => <OverviewTab {...props} />,
};
