// Item 2: valor de `_claude/rateLimit.unifiedWindows.*.utilization` do adaptador ACP, para comparar com a statusline.
// Uso: node src/q2-acp-utilization.ts [N prompts] [tag]
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, pickCheap, withAdapter } from "./lib.ts";
import { OUT, REPO } from "./paths.ts";

const N = Number(process.argv[2] ?? 3);
const tag = process.argv[3] ?? "q2";
const PROMPT = "Write the integers from 1 to 300 separated by single spaces. Output nothing else.";

type RL = Record<string, any> | undefined;
await withAdapter(`${tag}-acp`, {}, async (h) => {
  await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
  const t0 = Date.now();
  const newResp = (await h.cx.request(methods.agent.session.new, { cwd: REPO, mcpServers: [] } as never)) as any;
  const sessionId = newResp.sessionId as string;
  const tNew = Date.now() - t0;
  await pickCheap(h, sessionId, newResp);
  const rows: any[] = [];
  for (let i = 1; i <= N; i++) {
    const r = await h.prompt(sessionId, PROMPT, { tag: `${tag}-${i}` });
    const ups = h.updates(sessionId, r.from);
    // ultimo `_claude/rateLimit` visto neste prompt
    const rls = ups.map((u) => u.update._meta?.["_claude/rateLimit"] as RL).filter(Boolean);
    const rl = rls.at(-1);
    const row = {
      i,
      at: new Date().toISOString(),
      ms: r.ms,
      firstChunkMs: r.firstChunkMs,
      stopReason: r.stopReason,
      usage: r.usage,
      nRateLimitUpdates: rls.length,
      five_hour: rl?.unifiedWindows?.five_hour,
      seven_day: rl?.unifiedWindows?.seven_day,
      status: rl?.status,
      rateLimitType: rl?.rateLimitType,
      keys: rl ? Object.keys(rl) : null,
    };
    rows.push(row);
    appendFileSync(join(OUT, `${tag}-rows.jsonl`), JSON.stringify(row) + "\n");
    console.log(JSON.stringify(row));
  }
  writeFileSync(join(OUT, `${tag}-summary.json`), JSON.stringify({ tNewMs: tNew, rows }, null, 2));
});
