// Executa cenários de "cota acabando" contra um cliente ACP, com o mock local.
// Uso: node src/run.ts <claude|codex|opencode> <cenario> [<cenario>...]
//
// Cada cenário: (1) processo novo + sessão nova + prompt P1 sob o roteiro do mock;
//   (2) mock volta a responder e a MESMA sessão recebe P2 (a sessão continua viva?);
//   (3) o adaptador é encerrado e um processo novo faz session/load (a conversa volta? o texto parcial foi guardado?) + P3.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENTS, type ClientName } from './clients.ts';
import { Adapter, OUT, PROFILES, WT, alive, descendants, ensureRepo, result, scrubObj, sleep, summarizeMock, type PromptOutcome } from './lib.ts';
import { startMock, type Action, type Mock } from './mock.ts';

const P1 = 'Leia o arquivo README.txt com a ferramenta de leitura e diga a primeira palavra dele.';
const P2 = 'Responda apenas: pronto.';
const P3 = 'Qual foi o meu primeiro pedido nesta conversa? Responda numa frase.';

interface Scenario {
  desc: string;
  /** roteiro das requisições principais; `fallback` vale quando o roteiro acaba */
  plan: (cwd: string, c: (typeof CLIENTS)[ClientName]) => Action[];
  fallback: Action;
  /** tempo máximo do P1 antes de cancelar (ms) */
  timeoutMs?: number;
}

const R429 = (retryAfter: number | null = 1): Action => ({ kind: '429', retryAfter, resetInSec: 3600 });

export const SCENARIOS: Record<string, Scenario> = {
  // cota acaba antes do primeiro token
  's1-429-first': { desc: '429 antes do 1º token (retry-after: 1)', plan: () => [], fallback: R429(1) },
  's1b-429-first-no-retry-after': { desc: '429 antes do 1º token, sem retry-after', plan: () => [], fallback: R429(null) },
  's1c-429-first-retry-after-3600': { desc: '429 antes do 1º token, retry-after: 3600', plan: () => [], fallback: R429(3600) },
  // cota acaba no meio da tarefa: 1ª requisição pede ferramenta, a 2ª recebe 429
  's2-429-mid-task': { desc: 'ferramenta executada; 429 na requisição seguinte (retry-after: 1)', plan: (cwd, c) => [c.toolAction(cwd)], fallback: R429(1) },
  's2c-429-mid-task-retry-after-3600': { desc: 'ferramenta executada; 429 com retry-after: 3600', plan: (cwd, c) => [c.toolAction(cwd)], fallback: R429(3600) },
  // corte no meio do stream
  's3-cut-error-transient': { desc: 'stream cortado após 5 pedaços por erro overloaded; a próxima tentativa responde ok', plan: () => [{ kind: 'cut', after: 5, how: 'error', errorType: 'overloaded_error' }], fallback: { kind: 'ok' } },
  's4-cut-error-persistent': { desc: 'stream cortado após 5 pedaços por erro overloaded, sempre', plan: () => [], fallback: { kind: 'cut', after: 5, how: 'error', errorType: 'overloaded_error' } },
  's5-cut-destroy-transient': { desc: 'socket derrubado após 5 pedaços; a próxima tentativa responde ok', plan: () => [{ kind: 'cut', after: 5, how: 'destroy' }], fallback: { kind: 'ok' } },
  's6-cut-destroy-persistent': { desc: 'socket derrubado após 5 pedaços, sempre', plan: () => [], fallback: { kind: 'cut', after: 5, how: 'destroy' } },
  's7-cut-ratelimit-persistent': { desc: 'stream cortado após 5 pedaços por erro de cota (rate_limit_error), sempre', plan: () => [], fallback: { kind: 'cut', after: 5, how: 'error', errorType: 'rate_limit_error' } },
  // só Responses API (codex): response.failed com código do provedor
  's9-failed-insufficient-quota': { desc: 'response.failed insufficient_quota após 5 pedaços, sempre', plan: () => [], fallback: { kind: 'cut', after: 5, how: 'failed', errorType: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } },
  's10-failed-rate-limit-exceeded': { desc: 'response.failed rate_limit_exceeded (try again in 1.5s) após 5 pedaços, sempre', plan: () => [], fallback: { kind: 'cut', after: 5, how: 'failed', errorType: 'rate_limit_exceeded', message: 'Rate limit reached for mock-1 on tokens per min (TPM): Limit 1000, Used 1000, Requested 20. Please try again in 1.5s.' } },
  's11-failed-server-overloaded': { desc: 'response.failed server_is_overloaded após 5 pedaços, sempre', plan: () => [], fallback: { kind: 'cut', after: 5, how: 'failed', errorType: 'server_is_overloaded', message: 'Our servers are currently overloaded. Please try again later.' } },
  's12-429-plain-rate-limit': { desc: '429 genérico rate_limit_exceeded (estilo API da OpenAI), sempre', plan: () => [], fallback: { kind: '429', retryAfter: 1, resetInSec: 3600, plain: { code: 'rate_limit_exceeded', message: 'Rate limit reached for mock-1 on requests per min (RPM). Please try again in 1s.' } } },
  's13-429-plain-insufficient-quota': { desc: '429 genérico insufficient_quota (estilo API da OpenAI), sempre', plan: () => [], fallback: { kind: '429', retryAfter: null, plain: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } } },
  // corte depois da ferramenta (meio da tarefa) com texto parcial
  's8-cut-after-tool': { desc: 'ferramenta executada; a 2ª requisição corta o stream após 5 pedaços (erro), sempre', plan: (cwd, c) => [c.toolAction(cwd)], fallback: { kind: 'cut', after: 5, how: 'error', errorType: 'overloaded_error' } },
};

function filesContaining(root: string, needle: string, maxFiles = 4000): string[] {
  const hits: string[] = [];
  let seen = 0;
  const walk = (d: string) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (++seen < maxFiles) {
        try {
          if (statSync(p).size < 300_000_000 && readFileSync(p).includes(needle)) hits.push(p.slice(root.length + 1));
        } catch {}
      }
    }
  };
  walk(root);
  return hits;
}

const profileRoot = (c: ClientName) => join(PROFILES, c === 'claude' ? 'claude-quota' : c === 'codex' ? 'codex-quota' : 'opencode-quota');

async function runScenario(client: ClientName, id: string, mock: Mock) {
  const def = CLIENTS[client];
  const sc = SCENARIOS[id];
  if (!sc) throw new Error('cenário desconhecido ' + id);
  const cwd = WT({ claude: 1, codex: 2, opencode: 3 }[client]);
  const typed = !!process.env.QUOTA_TYPED && (client === 'codex' || client === 'claude');
  const rep = process.env.QUOTA_REP ? `-r${process.env.QUOTA_REP}` : '';
  const tag = `${client}-${id}${typed ? '-typed' : ''}${rep}`;
  const caps = typed ? { _meta: { jetbrains: { air: { version: 1, capabilities: ['sessionFailure'] } } } } : {};
  const rec: Record<string, any> = { typedFailures: typed, client, scenario: id, desc: sc.desc, startedAt: new Date().toISOString() };
  mock.markers = ['PARTE-05', 'PARTE-12', 'README.txt', 'Responda apenas: pronto', 'mock-tool-ok', 'primeiro pedido'];

  // perfil limpo a cada cenário: o texto parcial só pode vir deste cenário
  rmSync(profileRoot(client), { recursive: true, force: true });

  // ---------- fase 1: P1 sob o roteiro ----------
  mock.clearLog();
  mock.setPlan(sc.plan(cwd, def), sc.fallback);
  const a = Adapter.start(def.spec(`${tag}-a`));
  await a.initialize(caps);
  await def.afterInit?.(a);
  const s = await a.newSession(cwd);
  const sid = s.sessionId;
  rec.sessionIdPrefix = sid.slice(0, 8);
  rec.configure = await def.configure(a, sid, s);
  const mark1 = Date.now() - mock.t0;
  const p1 = await a.prompt(sid, P1, 'P1', sc.timeoutMs ?? 300_000);
  await sleep(1500);
  rec.p1 = trimOutcome(p1);
  rec.p1Mock = summarizeMock(mock.log, mark1);
  rec.p1MockMain = mock.mainLog().filter((l) => l.tMs >= mark1).map((l) => ({ t: l.tMs - mark1, action: l.action, stream: l.stream, retry: l.retryCount, hist: l.hist, hits: l.hits }));
  rec.adapterAliveAfterP1 = alive(a.pid) && !a.exited;
  rec.mockOtherPaths = [...new Set(mock.log.filter((l) => !l.main && !l.action.startsWith('aux')).map((l) => `${l.method} ${l.path}`))];

  // ---------- fase 2: a mesma sessão aceita novo prompt quando o mock volta ao normal? ----------
  mock.setFallback({ kind: 'ok', chunks: 3 });
  const mark2 = Date.now() - mock.t0;
  const p2 = await a.prompt(sid, P2, 'P2-mesma-sessao-mock-ok', 120_000);
  rec.p2 = trimOutcome(p2);
  rec.p2MockMain = mock.mainLog().filter((l) => l.tMs >= mark2).map((l) => ({ t: l.tMs - mark2, action: l.action, stream: l.stream, retry: l.retryCount, hist: l.hist, hits: l.hits }));

  // ---------- onde o texto parcial foi parar? (procura nos arquivos do perfil isolado) ----------
  rec.persistedMarkers = {
    'PARTE-05': filesContaining(profileRoot(client), 'PARTE-05').map(maskPath),
    'README.txt (pedido)': filesContaining(profileRoot(client), 'Leia o arquivo README.txt').length,
  };

  // ---------- fase 3: processo novo + session/load ----------
  const kids = descendants(a.pid).map((p) => p.pid);
  await a.stop();
  rec.leftoverAfterStop = kids.filter(alive).length;
  mock.setFallback({ kind: 'ok', chunks: 3 });
  const b = Adapter.start(def.spec(`${tag}-b`));
  await b.initialize(caps);
  await def.afterInit?.(b);
  const evFrom = b.events.length;
  const t0 = performance.now();
  let loadResp: any;
  try {
    loadResp = await b.loadSession(sid, cwd);
    rec.load = { ok: true, ms: Math.round(performance.now() - t0) };
  } catch (e: any) {
    rec.load = { ok: false, ms: Math.round(performance.now() - t0), error: { code: e?.code, message: String(e?.message ?? e) } };
  }
  if (rec.load.ok) {
    await sleep(500);
    rec.load.replay = b.replaySince(evFrom, sid);
    rec.load.replay.agentText = rec.load.replay.agentText.slice(0, 400);
    rec.load.replay.userText = rec.load.replay.userText.slice(0, 400);
    rec.load.configAfterLoad = await def.configure(b, sid, loadResp);
    const mark3 = Date.now() - mock.t0;
    const p3 = await b.prompt(sid, P3, 'P3-apos-load', 120_000);
    rec.p3 = trimOutcome(p3);
    rec.p3MockMain = mock.mainLog().filter((l) => l.tMs >= mark3).map((l) => ({ t: l.tMs - mark3, action: l.action, stream: l.stream, retry: l.retryCount, nInput: l.nInput, hist: l.hist, hits: l.hits }));
  }
  await b.stop();
  rec.finishedAt = new Date().toISOString();
  result(`${client}-results.jsonl`, tag, scrubObj(rec));
  return rec;
}

function trimOutcome(o: PromptOutcome) {
  return { ...o, agentText: o.agentText.slice(0, 500), usageUpdates: o.usageUpdates.slice(-3), extNotifications: o.extNotifications.slice(0, 6) };
}
function maskPath(p: string) {
  return p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [client, ...ids] = process.argv.slice(2) as [ClientName, ...string[]];
  if (!CLIENTS[client]) throw new Error('cliente inválido: claude | codex | opencode');
  ensureRepo();
  const def = CLIENTS[client];
  const mock = await startMock(def.flavor, def.port, join(OUT, `${client}-mock.jsonl`));
  try {
    for (const id of ids) {
      console.log(`\n##### ${client} / ${id} @ ${new Date().toISOString()}`);
      await runScenario(client, id, mock);
    }
  } finally {
    await mock.stop();
  }
  process.exit(0);
}
