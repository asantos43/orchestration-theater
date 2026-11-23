// SPDX-License-Identifier: MPL-2.0
import type { PlaySpan, PlaySpans } from '@otheater/protocol';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../../layout/themed-text.js';
import { Section, type SectionControl } from '../../layout/section.js';
import { cellWidth, fit } from '../../layout/text.js';
import { TOKEN } from '../../layout/theme.js';
import { formatDuration } from './panels-model.js';
import { shownOf, SourceNotice } from './source-notice.js';
import type { SourceLoad } from './use-panels.js';

/**
 * What the section of the play has to say when there is no tree to draw: there is no scenario
 * selected, the scenario has no play, or the Trajectories tab follows a direct session (it has no
 * play and the daemon makes no span of it).
 */
export type PlayPanelSubject =
  | { readonly kind: 'none'; readonly why: 'noScenario' | 'noPlay' | 'direct' }
  | { readonly kind: 'play'; readonly id: string };

/**
 * The span tree of the play of the Usage tab (Phase 8, P10; architecture 5.13): the duration of
 * each stage, attempt, session, tool call and wait of the play the Trajectories tab follows
 * (`GET /v1/plays/:id/spans`, the spans of the daemon). At most `rows` lines; the rest is counted.
 */

function Line(props: { readonly span: PlaySpan; readonly width: number }): ReactNode {
  const { t } = useTranslation();
  const { span, width } = props;
  const duration = formatDuration(span.durationMs);
  const label = [t(`usage.play.kind.${span.kind}`), span.label === '' ? undefined : span.label]
    .filter((part) => part !== undefined)
    .join(' ');
  const detail = span.detail === null ? '' : ` (${span.detail})`;
  const failed = span.status === 'error' ? ` ${t('usage.play.failed')}` : '';
  // The mark of a failure is part of the text that is cut to fit, so the duration is never pushed out.
  const left = `${'  '.repeat(span.depth)}${label}${detail}`;
  const room = Math.max(1, width - cellWidth(duration) - 1 - cellWidth(failed));
  return (
    <Text wrap="truncate">
      {fit(left, room)}
      {failed === '' ? null : <Text color={TOKEN.error}>{failed}</Text>}{' '}
      <Text dimColor>{duration}</Text>
    </Text>
  );
}

export function PlaySection(props: {
  readonly subject: PlayPanelSubject;
  readonly load: SourceLoad<PlaySpans>;
  /** `ui.usage.spanRows`. */
  readonly rows: number;
  readonly width: number;
  readonly control: SectionControl;
}): ReactNode {
  const { t } = useTranslation();
  const { subject, load, width } = props;
  const shown = shownOf(load);
  const tree = shown?.value;
  let body: ReactNode;
  if (subject.kind === 'none') {
    body = (
      <Text dimColor wrap="truncate">
        {t(`usage.play.${subject.why}`)}
      </Text>
    );
  } else {
    body = (
      <>
        <SourceNotice load={load} width={width} />
        {tree === undefined ? null : tree.spans.length === 0 ? (
          <Text dimColor wrap="truncate">
            {t('usage.play.empty')}
          </Text>
        ) : (
          <>
            {tree.spans.slice(0, props.rows).map((span) => (
              <Line key={span.spanId} span={span} width={width} />
            ))}
            {tree.spans.length > props.rows && (
              <Text dimColor wrap="truncate">
                {t('usage.play.more', { count: tree.spans.length - props.rows })}
              </Text>
            )}
          </>
        )}
        {tree !== undefined && !tree.playClosed && (
          <Text dimColor wrap="truncate">
            {fit(t('usage.play.running'), width)}
          </Text>
        )}
        {tree?.truncated === true && (
          <Text color={TOKEN.warn} wrap="truncate">
            {fit(t('usage.play.truncated'), width)}
          </Text>
        )}
      </>
    );
  }
  return (
    <Section
      id="usage.play"
      title={t('usage.play.title')}
      right={subject.kind === 'play' ? subject.id : undefined}
      width={width}
      control={props.control}
    >
      {body}
    </Section>
  );
}
