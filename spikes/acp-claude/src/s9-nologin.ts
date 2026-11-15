// Zero prompts: perfil vazio (CLAUDE_CONFIG_DIR), sem login. So observa initialize e session/new.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, withAdapter } from "./lib.ts";
import { OUT, WT } from "./paths.ts";

const dir = process.argv[2]!;
await withAdapter("s9-nologin", { env: { CLAUDE_CONFIG_DIR: dir } }, async (h) => {
  const out: any = {};
  try {
    const i = (await h.cx.request(methods.agent.initialize, INIT_PARAMS as never)) as any;
    out.initialize = { authMethods: i.authMethods, auth: i.agentCapabilities?.auth };
  } catch (e: any) { out.initializeError = String(e?.message ?? e); }
  try {
    const r = (await h.cx.request(methods.agent.session.new, { cwd: WT(1), mcpServers: [] } as never)) as any;
    out.sessionNew = { ok: true, sessionId: r.sessionId, models: r.models?.availableModels?.map((m: any) => m.modelId) };
  } catch (e: any) { out.sessionNewError = { message: e?.message, code: e?.code, data: e?.data }; }
  writeFileSync(join(OUT, "s9-summary.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
