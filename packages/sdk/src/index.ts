// SPDX-License-Identifier: MPL-2.0
/**
 * Conformance suites of the `@otheater/core` ports (architecture 5.18, rule 5). Each is a function
 * that registers Vitest tests: an adapter author calls it from a test file with a factory that
 * builds a fresh instance of the adapter, and the adapter passes when the file passes.
 *
 * ```ts
 * import { describeClockConformance } from '@otheater/sdk';
 * describeClockConformance('my-clock', () => ({ clock: new MyClock(), advance: wait }));
 * ```
 */
export { type AdapterFactory, type Disposable } from './harness.js';
export { describeClockConformance, type ClockHarness } from './conformance/clock.js';
export {
  describeEventLogConformance,
  sampleEvent,
  type EventLogHarness,
} from './conformance/event-log.js';
export { describeStoreConformance, type StoreHarness } from './conformance/store.js';
export { sampleAttempt } from './conformance/attempt-registry.js';
export { type AggregateHarness } from './conformance/aggregate-support.js';
export {
  describeScenarioAggregatesConformance,
  sampleAttachment,
  sampleRepo,
  sampleScenario,
} from './conformance/scenario-aggregates.js';
export {
  describePlayAggregatesConformance,
  sampleDecision,
  sampleDemand,
  samplePlay,
  sampleStage,
} from './conformance/play-aggregates.js';
export {
  describeCoordinationAggregatesConformance,
  sampleDirective,
  samplePrompt,
  sampleSession,
  sampleSideEffect,
} from './conformance/coordination-aggregates.js';
export { describeIdeaAggregatesConformance, sampleIdea } from './conformance/idea-aggregates.js';
export { describeAggregateTransactionsConformance } from './conformance/aggregate-transactions.js';
export {
  describeSecretVaultConformance,
  type SecretVaultHarness,
} from './conformance/secret-vault.js';
// ProcessLauncher
export {
  describeProcessLauncherConformance,
  type ProcessLauncherHarness,
} from './conformance/process-launcher.js';
// PromptSource
export {
  describePromptSourceConformance,
  type PromptSourceHarness,
} from './conformance/prompt-source.js';
// Vcs
export { describeVcsConformance, testGit, type VcsHarness } from './conformance/vcs.js';
export { disposeTestGitIsolation } from './conformance/git-isolation.js';
// CodeHost
export { describeCodeHostConformance, type CodeHostHarness } from './conformance/code-host.js';
// LocalModelServer
export {
  describeLocalModelServerConformance,
  type LocalModelServerHarness,
  type LocalServerBehavior,
} from './conformance/local-model-server.js';
// AgentSession / ClientAdapter
export {
  describeAgentSessionConformance,
  type AgentSessionHarness,
  type AgentSessionPrompts,
} from './conformance/agent-session.js';
export {
  describeClientAdapterConformance,
  type ClientAdapterHarness,
} from './conformance/client-adapter.js';
export { realClientFlags, type ClientConformanceOptions } from './conformance/helpers.js';
// Real clients: how many sessions one process takes (N57; used by the `*.real.test.ts` files)
export {
  describeSessionsReport,
  probeSessionsPerProcess,
  realSessionsPerProcess,
  type SessionsPerProcessProbe,
  type SessionsPerProcessReport,
} from './conformance/sessions-per-process.js';
