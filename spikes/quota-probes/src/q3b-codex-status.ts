// Item 3 (comparacao): texto do `/status` do codex-acp (tratado localmente pelo adaptador, sem turno do modelo)
// ao lado do `account/rateLimits/read` cru. O e-mail e o caminho do usuario sao mascarados antes de gravar o resumo.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { OUT, REPO } from "./paths.ts";

const ADAPTER_JS = join(import.meta.dirname, "..", "..", "acp-codex", "node_modules/@agentclientprotocol/codex-acp/dist/index.js");
// usa o `codex` do PATH (0.169.0), como no item 3
const env = { ...process.env } as Record<string, string>;
delete env.CODEX_PATH;
const child = spawn(process.execPath, [ADAPTER_JS], { env, stdio: ["pipe", "pipe", "pipe"] });
const texts: string[] = [];
const kinds: Record<string, number> = {};
const metas: unknown[] = [];
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
const app = acp.client({ name: "otheater-spike" }).onNotification(acp.methods.client.session.update, ({ params }) => {
  const u = params.update as any;
  kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1;
  if (u.content?.type === "text") texts.push(u.content.text);
  if (u.sessionUpdate === "usage_update") metas.push(u);
});
const conn = app.connect(stream);
const t0 = Date.now();
await conn.agent.request(acp.methods.agent.initialize, {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "otheater-spike", title: "quota-probes", version: "0.0.0" },
});
const s = await conn.agent.request(acp.methods.agent.session.new, { cwd: REPO, mcpServers: [] });
const t1 = Date.now();
const st = await conn.agent.request(acp.methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "/status" }] });
const tStatusMs = Date.now() - t1;
const mask = (t: string) =>
  t
    .replace(/\([^)]*@[^)]*\)/g, "(e-mail omitido)")
    .replace(/\/tmp\/claude-1000\/\S+/g, "<scratchpad>")
    .replace(/`[0-9a-f-]{36}`/g, "`<id>`");
const text = mask(texts.join(""));
writeFileSync(join(OUT, "q3b-status.json"), JSON.stringify({ tNewMs: t1 - t0, tStatusMs, stopReason: st.stopReason, kinds, meta: st._meta, text }, null, 2));
console.log(JSON.stringify({ tNewMs: t1 - t0, tStatusMs, stopReason: st.stopReason, kinds, meta: st._meta }, null, 1));
console.log(text);
conn.close();
child.kill("SIGTERM");
setTimeout(() => {
  if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(0);
}, 1500);
