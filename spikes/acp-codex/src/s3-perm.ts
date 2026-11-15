// Item 5: request_permission (arquivo e comando), allow x reject, modos de sandbox/aprovação, escrita fora da worktree.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, WT, SCRATCH, result, newSession, runPrompt } from './lib.ts';

const OUTSIDE = join(SCRATCH, 'outside');
mkdirSync(OUTSIDE, { recursive: true });
const a = Adapter.start({ name: 's3-perm' });
await a.initialize();
const s = await newSession(a, WT(3), undefined, { model: 'gpt-6-luna', reasoning_effort: 'low', mode: 'read-only' });
const sid = s.sessionId;
const slim = (r: Awaited<ReturnType<typeof runPrompt>>) => ({ stopReason: r.stopReason, ms: r.ms, kinds: r.kinds, agentText: r.agentText, tools: r.tools, permissions: r.permissions });

// A: modo read-only, pede para criar arquivo -> allow
a.permission = 'allow';
const A = await runPrompt(a, sid, "Create the file a.txt in the current directory with the content 'hi'. Do nothing else.", 'perm-A-readonly-create-allow');
result('A read-only criar arquivo + ALLOW', { ...slim(A), exists: existsSync(join(WT(3), 'a.txt')) });

// B: idem -> reject
a.permission = 'reject';
const B = await runPrompt(a, sid, "Create the file b.txt in the current directory with the content 'hi'. Do nothing else.", 'perm-B-readonly-create-reject');
result('B read-only criar arquivo + REJECT', { ...slim(B), exists: existsSync(join(WT(3), 'b.txt')) });

// C: workspace-write, comando que escreve fora da worktree -> reject
await a.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: sid, configId: 'mode', value: 'workspace-write' });
const outC = join(OUTSIDE, 'c.txt');
const C = await runPrompt(a, sid, `Run the shell command: echo hi > ${outC}  . If it fails, report the exact error and do nothing else.`, 'perm-C-workspace-outside-reject');
result('C workspace-write escrever FORA + REJECT', { ...slim(C), exists: existsSync(outC), outsideDir: readdirSync(OUTSIDE) });

// D: idem -> allow
a.permission = 'allow';
const outD = join(OUTSIDE, 'd.txt');
const D = await runPrompt(a, sid, `Run the shell command: echo hi > ${outD}  . If it fails, report the exact error and do nothing else.`, 'perm-D-workspace-outside-allow');
result('D workspace-write escrever FORA + ALLOW', { ...slim(D), exists: existsSync(outD), outsideDir: readdirSync(OUTSIDE) });

await a.stop();
process.exit(0);
