// Item 5: request_permission e política de permissões do OpenCode em sessão ACP
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startAgent, type PromptResult } from './lib/agent.ts';
import { OUT, WT } from './lib/paths.ts';
import { initialize, newSession, pickCheap } from './lib/session.ts';
import type * as acp from '@agentclientprotocol/sdk/unstable';

type Answer = 'allow' | 'reject';
let answer: Answer = 'allow';
const policy = (req: acp.RequestPermissionRequest): acp.RequestPermissionResponse => {
  const want = answer === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const opt = req.options.find((o) => want.includes(o.kind));
  return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
};
const summary = (r: PromptResult) => ({
  label: r.label, stopReason: r.stopReason, ms: r.ms, toolCalls: r.toolCalls,
  nPermissionRequests: r.permissionRequests.length,
  permissionRequests: r.permissionRequests, usage: r.usage, text: r.text.slice(0, 200),
});
const out: Record<string, unknown> = {};
const exists = (p: string) => existsSync(p);

// B: OPENCODE_PERMISSION (env) edit=ask, bash=ask em wt2
{
  const ag = await startAgent({
    name: 's3b-env-ask', cwd: WT[1], permission: policy,
    env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'ask', bash: 'ask' }) },
  });
  await initialize(ag);
  const s = await newSession(ag, WT[1]);
  await pickCheap(ag, s.sessionId);
  answer = 'allow';
  const r1 = await ag.prompt(s.sessionId, 'Create the file b-allow.txt containing the word hi. Use the edit/write tool only.', 's3b-edit-allow');
  out.B1_edit_allow = { ...summary(r1), fileCreated: exists(join(WT[1], 'b-allow.txt')) };
  answer = 'reject';
  const r2 = await ag.prompt(s.sessionId, 'Use the bash tool to run exactly this command: echo hello-b2', 's3b-bash-reject');
  out.B2_bash_reject = summary(r2);
  await ag.close();
}
// C: opencode.json no cwd (wt3) com bash=deny, edit=allow; sem env
{
  writeFileSync(join(WT[2], 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { bash: 'deny', edit: 'allow' } }, null, 2));
  const ag = await startAgent({ name: 's3c-json-deny', cwd: WT[2], permission: policy });
  await initialize(ag);
  const s = await newSession(ag, WT[2]);
  await pickCheap(ag, s.sessionId);
  answer = 'allow';
  const r = await ag.prompt(s.sessionId, 'Use the bash tool to run exactly this command: touch deny-proof.txt . If you have no bash tool or it is refused, reply NOBASH.', 's3c-bash-deny-json');
  out.C_json_deny = { ...summary(r), commandRan: exists(join(WT[2], 'deny-proof.txt')) };
  await ag.close();
}
writeFileSync(join(OUT, 's3.result.json'), JSON.stringify(out, null, 1));
console.log('done s3');
