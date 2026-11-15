// Item 5: request_permission no modo "default" (Manual): payload, opcoes, permitir e recusar.
import { writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, pickCheap, withAdapter } from "./lib.ts";
import { OUT, WT } from "./paths.ts";

await withAdapter("s5-perms", {}, async (h) => {
  await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
  const cwd = WT(2);
  const newResp = (await h.cx.request(methods.agent.session.new, { cwd, mcpServers: [] } as never)) as any;
  const sessionId = newResp.sessionId as string;
  await pickCheap(h, sessionId, newResp);
  const m = await h.cx.request(methods.agent.session.setConfigOption, { sessionId, configId: "mode", value: "default" } as never);
  h.log.write({ ev: "mode_set", resp: JSON.stringify(m).slice(0, 300) });

  h.permPolicy = (req) => (h.log.write({ ev: "perm_payload", req }), { pick: "allow" });
  const n1 = h.permissions.length;
  const p1 = await h.prompt(sessionId, "Create the file a.txt containing the word alpha, then run the shell command `echo hi` and tell me its output in one line.", { tag: "perm-allow" });
  const perms1 = h.permissions.slice(n1);

  h.permPolicy = (req) => (h.log.write({ ev: "perm_payload", req }), { pick: "reject" });
  const n2 = h.permissions.length;
  const p2 = await h.prompt(sessionId, "Create the file b.txt containing the word beta, then run the shell command `echo no` and tell me its output in one line.", { tag: "perm-reject" });
  const perms2 = h.permissions.slice(n2);

  const summary = {
    sessionId,
    allow: { perms: perms1.map((p) => ({ tool: p.toolCall?.title, kind: p.toolCall?.kind, options: p.options })), stopReason: p1.stopReason, ms: p1.ms, usage: p1.usage, text: p1.text.slice(0, 200) },
    reject: { perms: perms2.map((p) => ({ tool: p.toolCall?.title, kind: p.toolCall?.kind, options: p.options })), stopReason: p2.stopReason, ms: p2.ms, usage: p2.usage, text: p2.text.slice(0, 300) },
    files: readdirSync(cwd),
  };
  writeFileSync(join(OUT, "s5-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
});
