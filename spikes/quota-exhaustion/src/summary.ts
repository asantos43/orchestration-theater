// Resume out/<cliente>-results.jsonl em linhas curtas. Uso: node src/summary.ts <cliente> [--json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './lib.ts';

const client = process.argv[2];
const rows = readFileSync(join(OUT, `${client}-results.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cut = (s: unknown, n = 110) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
for (const { name, data: d } of rows) {
  const p1 = d.p1, m = d.p1Mock;
  console.log(`\n== ${name}  (${d.desc})`);
  console.log(`P1: stop=${p1.stopReason ?? '-'} err=${p1.error ? `${p1.error.code} ${cut(p1.error.message, 90)} ${cut(JSON.stringify(p1.error.data), 120)}` : '-'} t=${p1.ms}ms timedOut=${p1.timedOut} cancelLat=${p1.cancelLatencyMs ?? '-'}`);
  console.log(`    texto="${cut(p1.agentText, 140)}" tools=${p1.toolCalls?.length} kinds=${JSON.stringify(p1.updateKinds)}`);
  console.log(`    mock: main=${m.main} aux=${m.aux} actions=${m.mainActions} gaps=${JSON.stringify(m.gapsMs)} retryHdr=${m.retryCounts} stream=${m.stream}`);
  if (p1.infoUpdates?.some((i: any) => i.meta)) console.log(`    info._meta=${cut(JSON.stringify(p1.infoUpdates.filter((i: any) => i.meta).map((i: any) => i.meta)), 700)}`);
  if (p1.respMeta || p1.respUsage) console.log(`    resp.usage=${cut(JSON.stringify(p1.respUsage), 100)} resp._meta=${cut(JSON.stringify(p1.respMeta), 200)}`);
  if (p1.extNotifications?.length) console.log(`    ext=${cut(JSON.stringify(p1.extNotifications), 300)}`);
  if (p1.usageUpdates?.length) console.log(`    usage=${cut(JSON.stringify(p1.usageUpdates.at(-1)), 160)}`);
  console.log(`    vivo apos P1=${d.adapterAliveAfterP1}`);
  console.log(`P2: stop=${d.p2?.stopReason} err=${d.p2?.error ? cut(d.p2.error.message, 80) : '-'} t=${d.p2?.ms} texto="${cut(d.p2?.agentText, 80)}" mock=${d.p2MockMain?.map((x: any) => x.action).join(',')} hist=${JSON.stringify(d.p2MockMain?.[0]?.hist)}`);
  console.log(`persistido: ${JSON.stringify(d.persistedMarkers)} sobrou=${d.leftoverAfterStop}`);
  const l = d.load;
  console.log(`load: ok=${l?.ok} ${l?.ms}ms ${l?.error ? cut(l.error.message, 100) : ''} replay.agent="${cut(l?.replay?.agentText, 120)}" replay.user="${cut(l?.replay?.userText, 100)}" kinds=${JSON.stringify(l?.replay?.kinds ?? l?.replay?.updateKinds ?? '')}`);
  console.log(`P3: stop=${d.p3?.stopReason} err=${d.p3?.error ? cut(d.p3.error.message, 80) : '-'} texto="${cut(d.p3?.agentText, 100)}" mock hist=${JSON.stringify(d.p3MockMain?.[0]?.hist)} hits=${JSON.stringify(d.p3MockMain?.[0]?.hits)}`);
}
