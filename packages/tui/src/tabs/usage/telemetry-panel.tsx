// SPDX-License-Identifier: MPL-2.0
import { formatTokens } from '@otheater/client';
import type { TelemetryStatus } from '@otheater/protocol';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../../layout/themed-text.js';
import { Section, type SectionControl } from '../../layout/section.js';
import { fit } from '../../layout/text.js';
import { TOKEN, paint } from '../../layout/theme.js';
import { formatClock } from '../use-now.js';
import { shownOf, SourceNotice } from './source-notice.js';
import type { SourceLoad } from './use-panels.js';

/**
 * The state of the telemetry in the Usage tab (Phase 8, P10; architecture 5.13): the OTLP receiver
 * (P2) and what it refused, the telemetry base, and what leaves the daemon (P7) with what it
 * dropped (`GET /v1/telemetry`). Counts and states only.
 */

function total(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

export function TelemetrySection(props: {
  readonly load: SourceLoad<TelemetryStatus>;
  readonly width: number;
  readonly control: SectionControl;
}): ReactNode {
  const { t } = useTranslation();
  const { load, width } = props;
  const shown = shownOf(load);
  const status = shown?.value;
  const line = (key: string, options: Record<string, string | number> = {}): string =>
    fit(t(key, options), width);
  return (
    <Section
      id="usage.telemetry"
      title={t('usage.telemetry.title')}
      right={shown === undefined ? undefined : t('usage.updated', { time: formatClock(shown.at) })}
      width={width}
      control={props.control}
    >
      <SourceNotice load={load} width={width} />
      {status === undefined ? null : (
        <>
          <Text
            wrap="truncate"
            {...paint(status.state === 'on' || status.state === 'off' ? undefined : TOKEN.warn)}
          >
            {line(`usage.telemetry.state.${status.state}`, { port: status.receiver?.port ?? 0 })}
          </Text>
          {status.receiver !== null && (
            <>
              <Text wrap="truncate">
                {line('usage.telemetry.accepted', {
                  traces: formatTokens(status.receiver.accepted.traces),
                  metrics: formatTokens(status.receiver.accepted.metrics),
                  logs: formatTokens(status.receiver.accepted.logs),
                })}
              </Text>
              <Text
                wrap="truncate"
                {...(total(status.receiver.rejected) > 0
                  ? { color: TOKEN.warn }
                  : { dimColor: true })}
              >
                {line('usage.telemetry.rejected', {
                  format: status.receiver.rejected.format,
                  size: status.receiver.rejected.size,
                  token: status.receiver.rejected.token,
                })}
              </Text>
            </>
          )}
          <Text wrap="truncate" dimColor={!status.daemonSpans}>
            {line(`usage.telemetry.daemonSpans.${status.daemonSpans ? 'on' : 'off'}`)}
          </Text>
          {status.base !== null && (
            <Text wrap="truncate" {...(status.base.state === 'ok' ? {} : { color: TOKEN.warn })}>
              {line('usage.telemetry.base', {
                state: t(`usage.telemetry.baseState.${status.base.state}`),
                written: formatTokens(status.base.written),
                queued: status.base.queued,
                overflow: status.base.droppedOverflow,
                discarded: status.base.discarded,
              })}
            </Text>
          )}
          <Text wrap="truncate">
            {line('usage.telemetry.export', {
              mode: t(`usage.telemetry.exportMode.${status.export.mode}`),
            })}
          </Text>
          {status.export.otlp !== null && (
            <>
              <Text wrap="truncate">
                {line('usage.telemetry.otlp', {
                  destination: status.export.otlp.destination,
                  exported: formatTokens(status.export.otlp.exported),
                })}
              </Text>
              {total(status.export.otlp.dropped) > 0 && (
                <Text color={TOKEN.warn} wrap="truncate">
                  {line('usage.telemetry.dropped', {
                    count: total(status.export.otlp.dropped),
                    reasons: Object.entries(status.export.otlp.dropped)
                      .filter(([, count]) => count > 0)
                      .map(([reason, count]) => `${reason} ${String(count)}`)
                      .join(', '),
                  })}
                </Text>
              )}
            </>
          )}
          {status.export.prometheus && (
            <Text wrap="truncate">{line('usage.telemetry.prometheus')}</Text>
          )}
        </>
      )}
    </Section>
  );
}
