// Itens 1, 2, 3 e 5: initialize, session/new com MCP HTTP, streaming, request_permission (permitir e recusar).
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, describeConfig, pickCheap, withAdapter } from "./lib.ts";
import { startMcp } from "./mcp-server.ts";
import { OUT, WT } from "./paths.ts";

const mcp = await startMcp("s1-mcp");
try {
  await withAdapter("s1-basic", {}, async (h) => {
    const init = await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
    h.log.write({ ev: "RESULT_initialize", init });

    const cwd = WT(1);
    const newResp = (await h.cx.request(methods.agent.session.new, {
      cwd,
      mcpServers: [{ type: "http", name: "spike", url: `${mcp.url}/wt1`, headers: [] }],
      _meta: { claudeCode: { emitRawSDKMessages: [{ type: "system", subtype: "init" }] } },
    } as never)) as any;
    const sessionId = newResp.sessionId as string;
    h.log.write({ ev: "RESULT_session_new", sessionId, config: describeConfig(newResp), modes: newResp.modes, models: newResp.models, meta: newResp._meta });
    const applied = await pickCheap(h, sessionId, newResp);

    // Prompt 1: MCP (ping + submit_result)
    h.permPolicy = (req) => {
      h.log.write({ ev: "perm_payload", req });
      return { pick: "allow" };
    };
    const p1 = await h.prompt(sessionId, "Call the MCP tool ping, then call the MCP tool submit_result with summary 'ok'. Then reply with the single word done.", { tag: "mcp" });

    // Prompt 2: criar arquivo + shell, permitir
    const nPerm2 = h.permissions.length;
    const p2 = await h.prompt(sessionId, "Create the file a.txt containing the word alpha, then run the shell command `echo hi` and tell me its output in one line.", { tag: "perm-allow" });
    const perms2 = h.permissions.slice(nPerm2).length;

    // Prompt 3: recusar
    h.permPolicy = (req) => {
      h.log.write({ ev: "perm_payload", req });
      return { pick: "reject" };
    };
    const nPerm3 = h.permissions.length;
    const p3 = await h.prompt(sessionId, "Create the file b.txt containing the word beta, then run the shell command `echo no` and tell me its output in one line.", { tag: "perm-reject" });
    const perms3 = h.permissions.length - nPerm3;

    const init1 = h.rawSdkMessages(sessionId).find((m) => m.message?.type === "system" && m.message?.subtype === "init");
    const summary = {
      sessionId,
      applied,
      mcpCalls: mcp.calls,
      p1: { ms: p1.ms, firstChunkMs: p1.firstChunkMs, stopReason: p1.stopReason, usage: p1.usage, types: p1.types, text: p1.text.slice(0, 200) },
      p2: { ms: p2.ms, firstChunkMs: p2.firstChunkMs, stopReason: p2.stopReason, usage: p2.usage, types: p2.types, perms: perms2, text: p2.text.slice(0, 200) },
      p3: { ms: p3.ms, firstChunkMs: p3.firstChunkMs, stopReason: p3.stopReason, usage: p3.usage, types: p3.types, perms: perms3, text: p3.text.slice(0, 200) },
      files: readdirSync(cwd),
      initMsgKeys: init1 ? Object.keys(init1.message ?? init1) : null,
      initTools: init1?.message?.tools,
      initMcp: init1?.message?.mcp_servers,
    };
    writeFileSync(join(OUT, "s1-summary.json"), JSON.stringify(summary, null, 2));
    writeFileSync(join(OUT, "state-session-wt1.json"), JSON.stringify({ sessionId, cwd }));
    console.log(JSON.stringify(summary, null, 2));
    void existsSync;
  });
} finally {
  await mcp.close();
}
