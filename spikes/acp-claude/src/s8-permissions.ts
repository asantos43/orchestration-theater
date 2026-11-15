// Item 8: entregar `tools` sem Bash via _meta.claudeCode.options. A: restrito (strict + sem Bash + dontAsk). B: controle sem strict, com .mcp.json no cwd.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, pickCheap, withAdapter } from "./lib.ts";
import { startMcp } from "./mcp-server.ts";
import { OUT, WT } from "./paths.ts";

const mcp = await startMcp("s8-mcp");
try {
  writeFileSync(join(WT(3), ".mcp.json"), JSON.stringify({ mcpServers: { projmcp: { type: "http", url: `${mcp.url}/project-mcp` } } }));
  await withAdapter("s8-permissions", {}, async (h) => {
    await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
    h.permPolicy = (req) => {
      h.log.write({ ev: "perm_payload", req });
      return { pick: "allow" };
    };
    const rawInit = (id: string) => h.rawSdkMessages(id).find((m) => m.message?.type === "system" && m.message?.subtype === "init")?.message;
    const brief = (m: any) => (m ? { tools: m.tools, mcp_servers: m.mcp_servers, permissionMode: m.permissionMode, model: m.model, slash_commands: m.slash_commands?.length, plugins: m.plugins, skills: m.skills?.length, agents: m.agents } : null);

    // A: restrito
    const a = (await h.cx.request(methods.agent.session.new, {
      cwd: WT(2),
      mcpServers: [{ type: "http", name: "spike", url: `${mcp.url}/restricted`, headers: [] }],
      _meta: {
        claudeCode: {
          emitRawSDKMessages: [{ type: "system", subtype: "init" }],
          options: {
            tools: ["Read", "Glob", "Grep", "Edit", "Write"],
            disallowedTools: ["Bash"],
            strictMcpConfig: true,
            allowDangerouslySkipPermissions: false,
            settings: { permissions: { defaultMode: "dontAsk", disableBypassPermissionsMode: "disable", deny: ["Bash"] } },
          },
        },
      },
    } as never)) as any;
    h.log.write({ ev: "RESULT_session_new_restricted", sessionId: a.sessionId, modes: a.modes });
    await pickCheap(h, a.sessionId, a);
    const pa = await h.prompt(a.sessionId, "Run the shell command `echo hi` with a Bash tool. If you have no Bash tool, reply exactly NO_BASH, followed by the list of your tool names.", { tag: "restricted-bash" });
    const nPermA = h.permissions.length;

    // B: controle (sem strict, sem restricao), cwd com .mcp.json
    const b = (await h.cx.request(methods.agent.session.new, {
      cwd: WT(3),
      mcpServers: [],
      _meta: { claudeCode: { emitRawSDKMessages: [{ type: "system", subtype: "init" }] } },
    } as never)) as any;
    await pickCheap(h, b.sessionId, b);
    const pb = await h.prompt(b.sessionId, "Reply with the single word ok.", { tag: "control-unrestricted" });

    const summary = {
      restricted: { prompt: { ms: pa.ms, stopReason: pa.stopReason, usage: pa.usage, text: pa.text.slice(0, 400), types: pa.types }, permissionRequests: nPermA, init: brief(rawInit(a.sessionId)), mcpCalls: mcp.calls },
      control: { prompt: { ms: pb.ms, stopReason: pb.stopReason, text: pb.text.slice(0, 100) }, init: brief(rawInit(b.sessionId)) },
    };
    writeFileSync(join(OUT, "s8-summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  });
} finally {
  await mcp.close();
}
