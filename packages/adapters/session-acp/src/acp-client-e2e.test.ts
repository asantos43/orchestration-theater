// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describeClientAdapterConformance, type ClientAdapterHarness } from '@otheater/sdk';
import {
  checkNothingOutlives,
  policy,
  profile,
  prompts,
  rig,
  script,
} from './testing/acp-e2e-rig.js';

// End to end over ACP with the real fake agent: see `testing/acp-e2e-rig.ts`.

checkNothingOutlives();

describeClientAdapterConformance('FakeClientAdapter + AcpTransport + fake-agent', async () => {
  const r = await rig();
  const edited = join(r.cwd, 'out.txt');
  const harness: ClientAdapterHarness = {
    adapter: r.adapter,
    via: r.via,
    profile,
    policy,
    cwd: r.cwd,
    prompts,
    permission: {
      prompt: script('edit-file', '{"path":"out.txt"}'),
      granted: () => existsSync(edited),
    },
    processesAlive: r.alive,
    dispose: r.dispose,
  };
  return harness;
});

for (const mode of ['escalate', 'always_kill', 'release'] as const) {
  describeClientAdapterConformance(
    `FakeClientAdapter + AcpTransport + fake-agent, multi-session, shared_cancel ${mode}`,
    async () => {
      const r = await rig('multi-session', mode);
      const edited = join(r.cwd, 'out.txt');
      const harness: ClientAdapterHarness = {
        adapter: r.adapter,
        via: r.via,
        profile,
        policy,
        cwd: r.cwd,
        prompts,
        sharedCancel: mode,
        permission: {
          prompt: script('edit-file', '{"path":"out.txt"}'),
          granted: () => existsSync(edited),
        },
        processesAlive: r.alive,
        rootProcessesAlive: r.alive,
        crash: () => r.launcher.killAll(),
        dispose: r.dispose,
      };
      return harness;
    },
  );
}
