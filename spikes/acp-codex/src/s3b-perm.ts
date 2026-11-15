// Item 5 (continuação): caminho fora da worktree E fora de /tmp (workspace-write libera /tmp por padrão no Codex).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, WT, OUT, result, newSession, runPrompt } from './lib.ts';

const a = Adapter.start({ name: 's3b-perm' });
await a.initialize();
const s = await newSession(a, WT(3), undefined, { model: 'gpt-6-luna', reasoning_effort: 'low', mode: 'workspace-write' });
const sid = s.sessionId;
const slim = (r: Awaited<ReturnType<typeof runPrompt>>) => ({ stopReason: r.stopReason, ms: r.ms, kinds: r.kinds, agentText: r.agentText, tools: r.tools, permissions: r.permissions });
const msg = (p: string) => `Create the file ${p} with the content 'hi', using a shell command. If the sandbox blocks it, ask for approval to run it outside the sandbox. If approval is denied, stop and report that.`;

a.permission = 'reject';
const x1 = join(OUT, 'outside-x1.txt');
const C = await runPrompt(a, sid, msg(x1), 'perm-C2-outside-tmp-reject');
result('C2 fora da worktree e fora de /tmp + REJECT', { ...slim(C), exists: existsSync(x1) });

a.permission = 'allow';
const x2 = join(OUT, 'outside-x2.txt');
const D = await runPrompt(a, sid, msg(x2), 'perm-D2-outside-tmp-allow');
result('D2 fora da worktree e fora de /tmp + ALLOW', { ...slim(D), exists: existsSync(x2) });
await a.stop();
process.exit(0);
