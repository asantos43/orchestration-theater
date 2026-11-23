// SPDX-License-Identifier: MPL-2.0
import type { DemandDiffState } from '@otheater/client';
import type { Trajectory, TrajectoryAttempt, TrajectoryTurn } from '@otheater/protocol';
import { Box } from 'ink';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '../../layout/themed-text.js';
import { Section } from '../../layout/section.js';
import { useTabHost } from '../../layout/tab-host.js';
import type { TabContentProps, TabDefinition } from '../../layout/tab-types.js';
import { fit } from '../../layout/text.js';
import { TOKEN, paint } from '../../layout/theme.js';
import { useStoreValue } from '../../use-store-value.js';
import {
  attemptSectionId,
  diffLines,
  diffOwners,
  diffSectionId,
  entryLines,
  foldedSet,
  followedSubject,
  trajectoryOf,
  TRANSITIONS_SECTION_ID,
  turnSectionId,
  visibleSections,
  wantedDiffs,
  type EntryLine,
  type Say,
} from './model.js';

/**
 * The Trajectories tab (P14 of docs/18, architecture 5.11): the trajectory of the latest play of
 * the scenario, built from its events. Each attempt is a step that opens into its turns, each turn
 * into what happened in it (what the Actor said, the tools it called, the permissions asked, the
 * terminal output when the client sends it), and the diff of the demand sits under the last
 * attempt of that demand. The history is read once and the stream of events keeps it live.
 */

const TONE_COLOR: Readonly<Record<EntryLine['tone'], string | undefined>> = {
  normal: undefined,
  dim: undefined,
  ok: TOKEN.ok,
  warn: TOKEN.warn,
  error: TOKEN.error,
};

const DIFF_COLOR = {
  add: TOKEN.ok,
  remove: TOKEN.error,
  hunk: TOKEN.accent,
  meta: undefined,
  context: undefined,
} as const;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function Lines(props: { readonly lines: readonly EntryLine[]; readonly width: number }): ReactNode {
  return props.lines.map((line, index) => (
    <Text
      // The lines of one entry have no identity of their own: the position is stable.
      key={index}
      wrap="truncate"
      dimColor={line.tone === 'dim'}
      {...paint(TONE_COLOR[line.tone])}
    >
      {fit(line.text, props.width)}
    </Text>
  ));
}

function TurnView(props: {
  readonly attempt: number;
  readonly turn: TrajectoryTurn;
  readonly width: number;
  readonly say: Say;
  readonly control: TabContentProps['sections'];
}): ReactNode {
  const { turn, width, say } = props;
  const title = say('trajectories.turn', { n: turn.index });
  const right = [
    turn.stopReason ?? (turn.endedAt === undefined ? say('trajectories.running') : undefined),
    turn.endedAt === undefined ? undefined : seconds(turn.endedAt - turn.startedAt),
    say('trajectories.entries', { count: turn.entries.length }),
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
  const lines = turn.entries.flatMap((entry) => entryLines(entry, width - 2, say));
  return (
    <Section
      id={turnSectionId(props.attempt, turn.index)}
      title={title}
      right={right}
      width={width}
      control={props.control}
    >
      <Box flexDirection="column" paddingLeft={2} width={width}>
        {lines.length === 0 ? (
          <Text dimColor wrap="truncate">
            {say('trajectories.emptyTurn')}
          </Text>
        ) : (
          <Lines lines={lines} width={width - 2} />
        )}
      </Box>
    </Section>
  );
}

function DiffView(props: {
  readonly attempt: number;
  readonly playId: string;
  readonly demandId: string;
  readonly width: number;
  readonly limit: number;
  readonly say: Say;
  readonly control: TabContentProps['sections'];
  readonly state: DemandDiffState | undefined;
}): ReactNode {
  const { state, width, say } = props;
  let body: ReactNode;
  if (state === undefined || state.load === 'loading') {
    body = (
      <Text dimColor wrap="truncate">
        {say('trajectories.diffLoading')}
      </Text>
    );
  } else if (state.load === 'failed' || state.value === undefined) {
    body = (
      <Text color={TOKEN.error} wrap="truncate">
        {fit(say('trajectories.diffFailed', { error: state.error ?? '' }), width - 2)}
      </Text>
    );
  } else if (!state.value.available) {
    body = (
      <Text dimColor wrap="truncate">
        {fit(say(`trajectories.diffUnavailable.${state.value.unavailable ?? 'no_vcs'}`), width - 2)}
      </Text>
    );
  } else if (state.value.diff === '') {
    body = (
      <Text dimColor wrap="truncate">
        {say('trajectories.diffEmpty')}
      </Text>
    );
  } else {
    const { lines, hidden } = diffLines(state.value.diff, props.limit);
    body = (
      <>
        {lines.map((line, index) => (
          <Text
            key={index}
            wrap="truncate"
            bold={line.kind === 'meta'}
            {...paint(DIFF_COLOR[line.kind])}
          >
            {fit(line.text, width - 2)}
          </Text>
        ))}
        {hidden > 0 && (
          <Text dimColor wrap="truncate">
            {fit(say('trajectories.diffMore', { count: hidden }), width - 2)}
          </Text>
        )}
        {state.value.truncated && (
          <Text color={TOKEN.warn} wrap="truncate">
            {fit(say('trajectories.diffCut'), width - 2)}
          </Text>
        )}
      </>
    );
  }
  return (
    <Section
      id={diffSectionId(props.attempt)}
      title={say('trajectories.diff', { demand: props.demandId })}
      width={width}
      control={props.control}
    >
      <Box flexDirection="column" paddingLeft={2} width={width}>
        {body}
      </Box>
    </Section>
  );
}

function AttemptView(props: {
  readonly number: number;
  readonly attempt: TrajectoryAttempt;
  readonly playId: string;
  readonly demandId: string | undefined;
  readonly width: number;
  readonly diffLimit: number;
  readonly say: Say;
  readonly control: TabContentProps['sections'];
  readonly diffs: Readonly<Record<string, DemandDiffState>>;
}): ReactNode {
  const { attempt, width, say } = props;
  const inner = width - 2;
  const right = [
    say(`trajectories.state.${attempt.state}`),
    say('trajectories.turns', { count: attempt.turns.length }),
  ].join(' · ');
  return (
    <Section
      id={attemptSectionId(props.number)}
      title={
        attempt.demandId === undefined
          ? say('trajectories.session')
          : say('trajectories.attempt', { n: props.number, demand: attempt.demandId })
      }
      right={right}
      width={width}
      control={props.control}
    >
      <Box flexDirection="column" paddingLeft={2} width={width}>
        {attempt.notices.map((notice) => (
          <Text key={notice.eventId} dimColor wrap="truncate">
            {fit(`${notice.type}${notice.detail === undefined ? '' : ` ${notice.detail}`}`, inner)}
          </Text>
        ))}
        {attempt.turns.map((turn) => (
          <TurnView
            key={turn.index}
            attempt={props.number}
            turn={turn}
            width={inner}
            say={say}
            control={props.control}
          />
        ))}
        {props.demandId !== undefined && (
          <DiffView
            attempt={props.number}
            playId={props.playId}
            demandId={props.demandId}
            width={inner}
            limit={props.diffLimit}
            say={say}
            control={props.control}
            state={props.diffs[`${props.playId}/${props.demandId}`]}
          />
        )}
      </Box>
    </Section>
  );
}

function TrajectoriesTab(props: TabContentProps): ReactNode {
  const { stores, settings } = useTabHost();
  const { scenarioId, width, sections } = props;
  const { t } = useTranslation();
  const say = useMemo<Say>(
    () => (key, values) => (values === undefined ? t(key) : t(key, values)),
    [t],
  );
  const config = settings.trajectories;
  const plays = useStoreValue(stores.plays, (state) => state.byId);
  const direct = useStoreValue(stores.trajectories, (state) => state.direct);
  const subject = useMemo(
    () => followedSubject(plays, direct, scenarioId, config.follow),
    [plays, direct, scenarioId, config.follow],
  );
  const playId = subject?.id;
  const held = useStoreValue(stores.trajectories, (state) =>
    playId === undefined ? undefined : state.plays[playId],
  );
  const diffs = useStoreValue(stores.trajectories, (state) => state.diffs);
  const trajectory = useMemo(
    () =>
      playId === undefined || held === undefined ? undefined : trajectoryOf(playId, held.events),
    [playId, held],
  );
  const toggled = useMemo(() => foldedToggled(sections.folded), [sections.folded]);

  useEffect(() => {
    stores.setTrajectoryKeep(config.keep);
  }, [stores, config.keep]);
  useEffect(() => {
    if (scenarioId !== undefined && config.follow !== 'play')
      void stores.loadDirectSessions(scenarioId);
  }, [stores, scenarioId, config.follow]);
  const isDirect = subject?.kind === 'direct';
  useEffect(() => {
    if (playId === undefined) return;
    if (isDirect) void stores.loadDirectTrajectory(playId);
    else void stores.loadTrajectory(playId);
  }, [stores, playId, isDirect]);
  const wanted = useMemo(
    () => wantedDiffs(trajectory, config.open, toggled),
    [trajectory, config.open, toggled],
  );
  useEffect(() => {
    if (playId === undefined || isDirect) return;
    for (const demandId of wanted) {
      if (diffs[`${playId}/${demandId}`] === undefined)
        void stores.loadDemandDiff(playId, demandId);
    }
  }, [stores, playId, isDirect, wanted, diffs]);

  if (playId === undefined) {
    return (
      <Text dimColor wrap="truncate">
        {say(scenarioId === undefined ? 'trajectories.noScenario' : 'trajectories.noPlay')}
      </Text>
    );
  }
  const header = (
    <Text bold wrap="truncate">
      {fit(say(isDirect ? 'trajectories.direct' : 'trajectories.play', { id: playId }), width)}
    </Text>
  );
  if (held === undefined || (held.load === 'loading' && held.events.length === 0)) {
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Text dimColor wrap="truncate">
          {say('trajectories.loading')}
        </Text>
      </Box>
    );
  }
  if (held.load === 'failed' && held.events.length === 0) {
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Text color={TOKEN.error} wrap="truncate">
          {fit(say('trajectories.failed', { error: held.error ?? '' }), width)}
        </Text>
      </Box>
    );
  }
  const resolved: typeof sections = {
    cursor: sections.cursor,
    folded: foldedSet(trajectory, config.open, toggled),
  };
  const owners = trajectory === undefined ? new Map<number, string>() : diffOwners(trajectory);
  return (
    <Box flexDirection="column" width={width}>
      {header}
      {held.dropped > 0 && (
        <Text color={TOKEN.warn} wrap="truncate">
          {fit(say('trajectories.dropped', { count: held.dropped }), width)}
        </Text>
      )}
      {held.load === 'failed' && (
        <Text color={TOKEN.warn} wrap="truncate">
          {fit(say('trajectories.stale', { error: held.error ?? '' }), width)}
        </Text>
      )}
      {trajectory === undefined || trajectory.attempts.length === 0 ? (
        <Text dimColor wrap="truncate">
          {say('trajectories.empty')}
        </Text>
      ) : (
        <>
          {trajectory.attempts.map((attempt, index) => (
            <AttemptView
              key={attempt.attemptId}
              number={index + 1}
              attempt={attempt}
              playId={playId}
              demandId={owners.get(index + 1)}
              width={width}
              diffLimit={config.diffLines}
              say={say}
              control={resolved}
              diffs={diffs}
            />
          ))}
          <TransitionsView trajectory={trajectory} width={width} say={say} control={resolved} />
        </>
      )}
    </Box>
  );
}

function TransitionsView(props: {
  readonly trajectory: Trajectory;
  readonly width: number;
  readonly say: Say;
  readonly control: TabContentProps['sections'];
}): ReactNode {
  const { trajectory, width, say } = props;
  if (trajectory.transitions.length === 0) return null;
  return (
    <Section
      id={TRANSITIONS_SECTION_ID}
      title={say('trajectories.transitions')}
      right={String(trajectory.transitions.length)}
      width={width}
      control={props.control}
    >
      <Box flexDirection="column" paddingLeft={2} width={width}>
        {trajectory.transitions.map((move, index) => (
          <Text key={index} dimColor wrap="truncate">
            {fit(`${move.demandId}: ${move.from ?? '-'} -> ${move.to}`, width - 2)}
          </Text>
        ))}
      </Box>
    </Section>
  );
}

/** What the person toggled: the shell hands the tab the whole folded set of the layout, markers aside. */
function foldedToggled(folded: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...folded].filter((id) => id.startsWith('trajectories.')));
}

export const trajectoriesTab: TabDefinition = {
  sections: (context, toggledSet) => {
    const { trajectories, plays } = context.stores;
    const subject = followedSubject(
      plays.getState().byId,
      trajectories.getState().direct,
      context.scenarioId,
      context.settings.trajectories.follow,
    );
    if (subject === undefined) return [];
    const held = trajectories.getState().plays[subject.id];
    const trajectory = held === undefined ? undefined : trajectoryOf(subject.id, held.events);
    return visibleSections(
      trajectory,
      context.settings.trajectories.open,
      foldedToggled(toggledSet),
    );
  },
  watch: (stores) => [stores.plays, stores.trajectories],
  render: (props) => <TrajectoriesTab {...props} />,
};
