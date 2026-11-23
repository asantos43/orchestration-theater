// SPDX-License-Identifier: MPL-2.0
import type { DaemonStores, SyncStatus } from '@otheater/client';
import { Box } from 'ink';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TOKEN } from './layout/theme.js';
import { Text } from './layout/themed-text.js';
import { useRenderControl } from './render-control.js';
import type { DaemonView } from './use-daemon.js';
import { useStoreValue } from './use-store-value.js';

interface RowProps {
  readonly label: string;
  readonly value: string;
}

function Row(props: RowProps): ReactNode {
  return (
    <Box>
      <Box width={22}>
        <Text dimColor>{props.label}</Text>
      </Box>
      <Text>{props.value}</Text>
    </Box>
  );
}

const MemoRow = memo(Row);

function SyncRows(props: { readonly stores: DaemonStores }): ReactNode {
  const { t } = useTranslation();
  const { memo: memoize } = useRenderControl();
  const phase = useStoreValue(props.stores.status, (s: SyncStatus) => s.phase);
  const connection = useStoreValue(props.stores.status, (s: SyncStatus) => s.connection);
  const scenarios = useStoreValue(props.stores.scenarios, (s) => Object.keys(s.byId).length);
  const plays = useStoreValue(props.stores.plays, (s) => Object.keys(s.byId).length);
  const decisions = useStoreValue(props.stores.decisions, (s) =>
    Object.values(s.byScenario).reduce((total, list) => total + list.length, 0),
  );
  const events = useStoreValue(props.stores.events, (s) => s.events.length);
  const Line = memoize ? MemoRow : Row;
  return (
    <>
      <Line label={t('status.label.sync')} value={t(`status.sync.${phase}`)} />
      <Line label={t('status.label.stream')} value={t(`status.connection.${connection}`)} />
      <Line label={t('status.label.scenarios')} value={String(scenarios)} />
      <Line label={t('status.label.plays')} value={String(plays)} />
      <Line label={t('status.label.decisions')} value={String(decisions)} />
      <Line label={t('status.label.events')} value={String(events)} />
    </>
  );
}

/** The minimal screen of P8: what the daemon is doing, from `ApiClient` and the stores of the client. */
export function StatusScreen(props: { readonly view: DaemonView }): ReactNode {
  const { t } = useTranslation();
  const { memo: memoize } = useRenderControl();
  const { view } = props;
  const Line = memoize ? MemoRow : Row;
  return (
    <Box flexDirection="column">
      <Text bold>{t('status.heading')}</Text>
      {view.kind === 'connecting' && <Text>{t('status.connecting')}</Text>}
      {view.kind === 'offline' && <Text color={TOKEN.warn}>{t('status.offline')}</Text>}
      {view.kind === 'failed' && (
        <Text color={TOKEN.error}>{t('status.failed', { message: view.message })}</Text>
      )}
      {view.kind === 'online' && (
        <>
          <Line
            label={t('status.label.daemon')}
            value={t('status.daemon_line', { version: view.status.version, pid: view.status.pid })}
          />
          <Line label={t('status.label.state')} value={t(`status.state.${view.status.state}`)} />
          <SyncRows stores={view.stores} />
        </>
      )}
    </Box>
  );
}
