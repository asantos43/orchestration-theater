import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCall } from './lib/mcp-server.ts';

export type Check = { ok: boolean; why: string };
export type Task = {
  id: string;
  kind: 'mcp' | 'native' | 'native+mcp';
  prompt: string;
  /** ferramentas MCP que a tarefa precisa chamar (para o critério "texto em vez de chamada") */
  needs: string[];
  check(calls: McpCall[], wt: string): Check;
};

const valid = (calls: McpCall[], tool: string) => calls.filter((c) => c.tool === tool && c.valid);
const sameSet = (a: string[], b: string[]) => a.length === b.length && b.every((x) => a.map((s) => s.toLowerCase()).includes(x));
const submitOk = (calls: McpCall[], status: string): Check | null => {
  const s = valid(calls, 'submit_result');
  if (s.length === 0) return { ok: false, why: 'submit_result não chamado (válido)' };
  if ((s[s.length - 1].args as any).status !== status) return { ok: false, why: `submit_result.status != ${status}` };
  return null;
};
const one = (calls: McpCall[], tool: string, n = 1) => {
  const v = valid(calls, tool);
  return v.length >= n ? v : null;
};

export const TASKS: Task[] = [
  {
    id: 'T1',
    kind: 'mcp',
    prompt:
      'Use the otheater MCP tools. Create a task titled "Fix login timeout" with priority high, labels bug and auth, assigned to Ana of team backend. Then call submit_result with status done and a one-line summary.',
    needs: ['create_task', 'submit_result'],
    check(calls) {
      const v = one(calls, 'create_task');
      if (!v) return { ok: false, why: 'create_task válido ausente' };
      const a = v[0].args as any;
      if (a.title !== 'Fix login timeout') return { ok: false, why: `título: ${a.title}` };
      if (a.priority !== 'high') return { ok: false, why: `priority: ${a.priority}` };
      if (!sameSet(a.labels, ['bug', 'auth'])) return { ok: false, why: `labels: ${JSON.stringify(a.labels)}` };
      if (a.assignee.name !== 'Ana' || a.assignee.team !== 'backend') return { ok: false, why: `assignee: ${JSON.stringify(a.assignee)}` };
      return submitOk(calls, 'done') ?? { ok: true, why: '' };
    },
  },
  {
    id: 'T2',
    kind: 'mcp',
    prompt:
      'Use the otheater MCP tools. Record these review findings in a single call: src/a.ts line 10 severity error; src/b.ts line 22 severity warning; src/c.ts line 3 severity info. Then call submit_result with status done.',
    needs: ['record_findings', 'submit_result'],
    check(calls) {
      const v = one(calls, 'record_findings');
      if (!v) return { ok: false, why: 'record_findings válido ausente' };
      const f = (v[0].args as any).findings as any[];
      const want = ['src/a.ts:10:error', 'src/b.ts:22:warning', 'src/c.ts:3:info'];
      const got = f.map((x) => `${x.file}:${x.line}:${x.severity}`);
      if (!sameSet(got, want) ) return { ok: false, why: `findings: ${got.join(',')}` };
      return submitOk(calls, 'done') ?? { ok: true, why: '' };
    },
  },
  {
    id: 'T3',
    kind: 'mcp',
    prompt:
      'Use the otheater MCP tools. First call get_sprint_info. Then create a task titled "Sprint kickoff" with priority medium, label planning, assigned to the sprint owner and the owner team returned by get_sprint_info. Then call submit_result with status done.',
    needs: ['get_sprint_info', 'create_task', 'submit_result'],
    check(calls) {
      if (!one(calls, 'get_sprint_info')) return { ok: false, why: 'get_sprint_info ausente' };
      const v = one(calls, 'create_task');
      if (!v) return { ok: false, why: 'create_task válido ausente' };
      const a = v[0].args as any;
      if (String(a.assignee.name).toLowerCase() !== 'carla' || a.assignee.team !== 'infra') return { ok: false, why: `assignee: ${JSON.stringify(a.assignee)}` };
      if (a.priority !== 'medium' || !sameSet(a.labels, ['planning'])) return { ok: false, why: `priority/labels: ${a.priority} ${JSON.stringify(a.labels)}` };
      return submitOk(calls, 'done') ?? { ok: true, why: '' };
    },
  },
  {
    id: 'T4',
    kind: 'mcp',
    prompt:
      'Use the otheater MCP tools. Create a task titled "Migrate database" with priority critical, labels db, migration and urgent, assigned to Bruno of team infra, with an estimate of 2.5 hours. Then call submit_result with status done, a summary, and artifacts ["MIGRATION.md"].',
    needs: ['create_task', 'submit_result'],
    check(calls) {
      const v = one(calls, 'create_task');
      if (!v) return { ok: false, why: 'create_task válido ausente' };
      const a = v[0].args as any;
      if (a.title !== 'Migrate database' || a.priority !== 'critical') return { ok: false, why: `título/priority: ${a.title}/${a.priority}` };
      if (!sameSet(a.labels, ['db', 'migration', 'urgent'])) return { ok: false, why: `labels: ${JSON.stringify(a.labels)}` };
      if (a.assignee.name !== 'Bruno' || a.assignee.team !== 'infra') return { ok: false, why: `assignee: ${JSON.stringify(a.assignee)}` };
      if (a.estimate_hours !== 2.5) return { ok: false, why: `estimate_hours: ${a.estimate_hours}` };
      const bad = submitOk(calls, 'done');
      if (bad) return bad;
      const s = valid(calls, 'submit_result').at(-1)!.args as any;
      if (!Array.isArray(s.artifacts) || !s.artifacts.includes('MIGRATION.md')) return { ok: false, why: `artifacts: ${JSON.stringify(s.artifacts)}` };
      return { ok: true, why: '' };
    },
  },
  {
    id: 'T5',
    kind: 'native',
    prompt:
      'In the file notes.txt of the current directory, replace the word "foo" with "bar" using your file editing tool. Then call the otheater submit_result tool with status done.',
    needs: ['submit_result'],
    check(calls, wt) {
      const f = join(wt, 'notes.txt');
      if (!existsSync(f)) return { ok: false, why: 'notes.txt sumiu' };
      const t = readFileSync(f, 'utf8');
      if (/foo/.test(t) || !/bar/.test(t)) return { ok: false, why: `notes.txt: ${JSON.stringify(t.slice(0, 80))}` };
      return submitOk(calls, 'done') ?? { ok: true, why: '' };
    },
  },
  {
    id: 'T6',
    kind: 'native+mcp',
    prompt:
      'Read the file version.txt in the current directory. Then use the otheater create_task tool: title "Release " followed by the version found in the file, priority low, label release, assigned to Dani of team frontend. Then call submit_result with status done.',
    needs: ['create_task', 'submit_result'],
    check(calls) {
      const v = one(calls, 'create_task');
      if (!v) return { ok: false, why: 'create_task válido ausente' };
      const a = v[0].args as any;
      if (a.title !== 'Release 2.4.1') return { ok: false, why: `título: ${a.title}` };
      if (a.priority !== 'low' || !sameSet(a.labels, ['release']) || a.assignee.name !== 'Dani' || a.assignee.team !== 'frontend') return { ok: false, why: `outros campos: ${JSON.stringify(a)}` };
      return submitOk(calls, 'done') ?? { ok: true, why: '' };
    },
  },
  {
    id: 'T7',
    kind: 'mcp',
    prompt:
      'Use the otheater MCP tools. Record these five findings in a single record_findings call: lib/db.ts line 101 error; lib/db.ts line 7 info; web/app.tsx line 55 warning; web/app.tsx line 56 warning; api/auth.ts line 300 error. Then call submit_result with status done.',
    needs: ['record_findings', 'submit_result'],
    check(calls) {
      const v = one(calls, 'record_findings');
      if (!v) return { ok: false, why: 'record_findings válido ausente' };
      const got = ((v[0].args as any).findings as any[]).map((x) => `${x.file}:${x.line}:${x.severity}`);
      const want = ['lib/db.ts:101:error', 'lib/db.ts:7:info', 'web/app.tsx:55:warning', 'web/app.tsx:56:warning', 'api/auth.ts:300:error'];
      if (!sameSet(got, want)) return { ok: false, why: `findings: ${got.join(',')}` };
      return submitOk(calls, 'done') ?? { ok: true, why: '' };
    },
  },
  {
    id: 'T8',
    kind: 'mcp',
    prompt:
      'Use the otheater MCP tools. Create a task titled "Update docs" with priority low, label docs, assigned to Eva of team frontend. Then call submit_result with status blocked and summary "waiting for review".',
    needs: ['create_task', 'submit_result'],
    check(calls) {
      const v = one(calls, 'create_task');
      if (!v) return { ok: false, why: 'create_task válido ausente' };
      const a = v[0].args as any;
      if (a.title !== 'Update docs' || a.priority !== 'low' || !sameSet(a.labels, ['docs']) || a.assignee.name !== 'Eva' || a.assignee.team !== 'frontend') return { ok: false, why: `args: ${JSON.stringify(a)}` };
      const bad = submitOk(calls, 'blocked');
      if (bad) return bad;
      const s = valid(calls, 'submit_result').at(-1)!.args as any;
      return s.summary === 'waiting for review' ? { ok: true, why: '' } : { ok: false, why: `summary: ${s.summary}` };
    },
  },
  {
    id: 'T9',
    kind: 'native+mcp',
    prompt:
      'Create the file report.md in the current directory containing exactly one line: "# Report" (use your file writing tool). Then call the otheater submit_result tool with status done and artifacts ["report.md"].',
    needs: ['submit_result'],
    check(calls, wt) {
      const f = join(wt, 'report.md');
      if (!existsSync(f)) return { ok: false, why: 'report.md não criado' };
      if (readFileSync(f, 'utf8').trim() !== '# Report') return { ok: false, why: `conteúdo: ${JSON.stringify(readFileSync(f, 'utf8').slice(0, 60))}` };
      const bad = submitOk(calls, 'done');
      if (bad) return bad;
      const s = valid(calls, 'submit_result').at(-1)!.args as any;
      return Array.isArray(s.artifacts) && s.artifacts.includes('report.md') ? { ok: true, why: '' } : { ok: false, why: `artifacts: ${JSON.stringify(s.artifacts)}` };
    },
  },
  {
    id: 'T10',
    kind: 'mcp',
    prompt:
      'Use the otheater MCP tools. Create two tasks, one call each. First: title "Write tests", priority medium, label qa, assigned to Fabio of team backend. Second: title "Fix typo", priority low, label docs, assigned to Gil of team frontend. Then call submit_result with status done.',
    needs: ['create_task', 'submit_result'],
    check(calls) {
      const v = one(calls, 'create_task', 2);
      if (!v) return { ok: false, why: 'menos de 2 create_task válidos' };
      const byTitle = Object.fromEntries(v.map((c) => [(c.args as any).title, c.args as any]));
      const a = byTitle['Write tests'], b = byTitle['Fix typo'];
      if (!a || !b) return { ok: false, why: `títulos: ${Object.keys(byTitle).join('|')}` };
      if (a.priority !== 'medium' || !sameSet(a.labels, ['qa']) || a.assignee.name !== 'Fabio' || a.assignee.team !== 'backend') return { ok: false, why: `Write tests: ${JSON.stringify(a)}` };
      if (b.priority !== 'low' || !sameSet(b.labels, ['docs']) || b.assignee.name !== 'Gil' || b.assignee.team !== 'frontend') return { ok: false, why: `Fix typo: ${JSON.stringify(b)}` };
      return submitOk(calls, 'done') ?? { ok: true, why: '' };
    },
  },
];
