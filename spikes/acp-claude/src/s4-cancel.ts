// Itens 3 e 4: streaming (tipos, tempo ate o 1o pedaco) e session/cancel no meio de um prompt.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, pickCheap, sleep, withAdapter } from "./lib.ts";
import { alive, tree } from "./proc.ts";
import { now } from "./log.ts";
import { OUT, WT } from "./paths.ts";

await withAdapter("s4-cancel", {}, async (h) => {
  await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
  const newResp = (await h.cx.request(methods.agent.session.new, { cwd: WT(3), mcpServers: [] } as never)) as any;
  const sessionId = newResp.sessionId as string;
  await pickCheap(h, sessionId, newResp);

  // A: cancelar durante a geracao de texto
  let cancelAt = 0;
  const pa = await h.prompt(sessionId, "Count from 1 to 400, one number per line, with no other text.", {
    tag: "cancel-text",
    onFirstChunk: () => {
      setTimeout(async () => {
        cancelAt = now();
        h.log.write({ ev: "cancel_sent", kind: "text" });
        await h.cx.notify(methods.agent.session.cancel, { sessionId });
      }, 1500);
    },
  });
  const endA = now();
  const textLines = pa.text.split("\n").length;

  // B: cancelar durante uma ferramenta (shell `sleep`)
  let cancelB = 0;
  let treeAtCancel: ReturnType<typeof tree> = [];
  const pb = await h.prompt(sessionId, "Run the shell command `sleep 45` and then reply with the word done.", {
    tag: "cancel-tool",
    onFirstChunk: () => {
      setTimeout(async () => {
        cancelB = now();
        treeAtCancel = tree(h.pid);
        h.log.write({ ev: "cancel_sent", kind: "tool", tree: treeAtCancel.map((p) => `${p.comm}:${p.pid}`) });
        await h.cx.notify(methods.agent.session.cancel, { sessionId });
      }, 3000);
    },
  });
  const endB = now();
  await sleep(1500);
  const treeAfter = tree(h.pid);
  const sleepers = treeAtCancel.filter((p) => p.comm === "sleep");
  const summary = {
    text: { stopReason: pa.stopReason, cancelLatencyMs: endA - cancelAt, firstChunkMs: pa.firstChunkMs, linesBeforeCancel: textLines, types: pa.types, usage: pa.usage },
    tool: {
      stopReason: pb.stopReason,
      cancelLatencyMs: endB - cancelB,
      firstChunkMs: pb.firstChunkMs,
      types: pb.types,
      treeAtCancel: treeAtCancel.map((p) => `${p.comm}:${p.pid}`),
      treeAfter: treeAfter.map((p) => `${p.comm}:${p.pid}`),
      sleepAliveAfter: sleepers.map((p) => ({ pid: p.pid, alive: alive(p.pid) })),
      usage: pb.usage,
    },
  };
  writeFileSync(join(OUT, "s4-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
});
