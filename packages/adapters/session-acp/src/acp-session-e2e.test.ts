// SPDX-License-Identifier: MPL-2.0
import type { AgentSession } from '@otheater/core';
import { describeAgentSessionConformance, type AgentSessionHarness } from '@otheater/sdk';
import {
  checkNothingOutlives,
  policy,
  profile,
  prompts,
  rig,
} from './testing/acp-e2e-rig.test-support.js';

// End to end over ACP with the real fake agent: see `testing/acp-e2e-rig.test-support.ts`.

checkNothingOutlives();

describeAgentSessionConformance('AcpTransport + fake-agent', async () => {
  const r = await rig();
  let current: AgentSession = await r.adapter.openSession(profile, policy, r.cwd, r.via);
  const harness: AgentSessionHarness = {
    get session() {
      return current;
    },
    prompts,
    processesAlive: r.alive,
    config: {
      valid: { id: 'model', value: 'fake-model-2' },
      invalidValue: { id: 'model', value: 'no-such-model' },
      unknownId: 'no-such-option',
    },
    reload: async () => {
      current = await r.adapter.loadSession(profile, policy, r.cwd, current.sessionId, r.via);
      return current;
    },
    crash: () => r.launcher.killAll(),
    dispose: r.dispose,
  };
  return harness;
});

describeAgentSessionConformance('AcpTransport + fake-agent, multi-session', async () => {
  const r = await rig('multi-session');
  let current: AgentSession = await r.adapter.openSession(profile, policy, r.cwd, r.via);
  const harness: AgentSessionHarness = {
    get session() {
      return current;
    },
    prompts,
    processesAlive: r.alive,
    rootProcessesAlive: r.alive,
    config: {
      valid: { id: 'model', value: 'fake-model-2' },
      invalidValue: { id: 'model', value: 'no-such-model' },
      unknownId: 'no-such-option',
    },
    reload: async () => {
      current = await r.adapter.loadSession(profile, policy, r.cwd, current.sessionId, r.via);
      return current;
    },
    sibling: () => r.adapter.openSession(profile, policy, r.cwd, r.via),
    crash: () => r.launcher.killAll(),
    dispose: r.dispose,
  };
  return harness;
});
