// SPDX-License-Identifier: MPL-2.0
import { Box } from 'ink';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDensity } from './density-context.js';
import { useTheme } from './theme-context.js';
import { Text } from './themed-text.js';
import type { Link } from './data.js';
import type { ScenarioMark } from './scenario-rows.js';
import { clip } from './text.js';
import { TOKEN } from './theme.js';
import type { UpdateHint } from './use-update-status.js';

/** The mark of the product, which is not translated; `comfortable` has the margin of the mockup before it. */
const BRAND = ' ◆ ot';

export interface HeaderProps {
  readonly width: number;
  readonly scenarioName: string | undefined;
  /** The need of the play being followed, short. */
  readonly play: string | undefined;
  readonly mark: ScenarioMark | undefined;
  readonly decisions: number;
  readonly address: string;
  /** The state of the link with the daemon. */
  readonly link: Link;
  /** A new version the daemon found or already has ready (Phase 10, P7). */
  readonly update?: UpdateHint | undefined;
}

const MARK_COLOR: Readonly<Record<ScenarioMark, string>> = {
  decision: TOKEN.warn,
  running: TOKEN.ok,
  done: TOKEN.ok,
  idle: TOKEN.headerText,
};

/** The top row: where the person is (scenario, play, state, decisions) and the daemon on the right. */
export function Header(props: HeaderProps): ReactNode {
  const { t } = useTranslation();
  const { width } = props;
  const where =
    props.scenarioName === undefined
      ? t('layout.header.noScenario')
      : props.play === undefined
        ? props.scenarioName
        : `${props.scenarioName} › ${props.play}`;
  const palette = useTheme();
  const { pad } = useDensity();
  const daemon = t('layout.header.daemon', { address: props.address });
  // The margin is taken from both ends: `pad` before the brand and `pad` more after the daemon.
  const room = Math.max(0, width - daemon.length - 6 - 4 - 2 * pad);
  return (
    <Box width={width} height={1} backgroundColor={palette.resolve(TOKEN.header)}>
      <Text color={TOKEN.headerText} wrap="truncate">
        <Text color={TOKEN.headerKey} bold>
          {' '.repeat(pad)}
          {BRAND}
        </Text>
        {' │ '}
        {clip(where, Math.max(8, Math.floor(room / 2)))}
        {props.mark !== undefined && (
          <>
            {' │ '}
            <Text color={MARK_COLOR[props.mark]}>●</Text> {t(`layout.state.${props.mark}`)}
          </>
        )}
        {props.decisions > 0 && (
          <>
            {' │ '}
            <Text color={TOKEN.warn} bold>
              ! {t('layout.header.decisions', { count: props.decisions })}
            </Text>
          </>
        )}
        {props.update !== undefined && (
          <>
            {' │ '}
            <Text color={TOKEN.ok}>
              {t(props.update.ready ? 'layout.header.updateReady' : 'layout.header.updateFound', {
                version: props.update.version,
              })}
            </Text>
            {props.update.apply && <Text dimColor> [{t('layout.header.updateApply')}]</Text>}
          </>
        )}
      </Text>
      <Box flexGrow={1} />
      <Text color={TOKEN.headerText} wrap="truncate">
        {daemon} <Text color={props.link === 'live' ? TOKEN.ok : TOKEN.warn}>●</Text>
        {props.link === 'live' ? '' : ` ${t(`layout.link.${props.link}`)}`}
        {' '.repeat(1 + pad)}
      </Text>
    </Box>
  );
}
