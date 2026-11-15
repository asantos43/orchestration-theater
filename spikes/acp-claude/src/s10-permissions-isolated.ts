// Item 8 (complemento, 2026-11-15): efeito ISOLADO de cada chave de permissão.
// O s8 mandou tools + disallowedTools + deny + dontAsk + disableBypass juntos; aqui cada caso usa um adaptador novo
// e muda uma coisa só. O comando de prova é `touch bash-<caso>.txt` (não é só leitura, então o modo "default" pergunta).
// Casos sem prompt só leem o catálogo de modos e tentam session/set_config_option.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { INIT_PARAMS, pickCheap, withAdapter, type Harness } from "./lib.ts";
import { OUT, WT } from "./paths.ts";

type Caso = {
  id: string;
  oQueMuda: string;
  cwd: string;
  options?: Record<string, unknown>;
  /** settings.local.json escrito no cwd antes de subir o adaptador (removido no fim) */
  arquivoSettings?: Record<string, unknown>;
  /** modo aplicado por set_config_option antes do prompt */
  modo?: string;
  /** modos tentados por set_config_option (registra aceito ou erro) antes do prompt */
  tentarModos?: string[];
  prompt?: "touch" | "ok";
  politica?: "allow" | "reject";
};

const T = WT(1);
const CASOS: Caso[] = [
  { id: "base", oQueMuda: "nada (controle), modo default", cwd: T, modo: "default", prompt: "touch", politica: "allow", tentarModos: [] },
  { id: "tools-only", oQueMuda: "só tools:[Read,Glob,Grep,Edit,Write]", cwd: T, options: { tools: ["Read", "Glob", "Grep", "Edit", "Write"] }, modo: "default", prompt: "touch", politica: "allow" },
  { id: "disallowed",oQueMuda: "só disallowedTools:[Bash]", cwd: T, options: { disallowedTools: ["Bash"] }, modo: "default", prompt: "touch", politica: "allow" },
  { id: "deny", oQueMuda: "só settings.permissions.deny:[Bash]", cwd: T, options: { settings: { permissions: { deny: ["Bash"] } } }, modo: "default", prompt: "touch", politica: "allow" },
  { id: "meta-dontask", oQueMuda: "só settings.permissions.defaultMode:dontAsk no _meta, depois modo default", cwd: T, options: { settings: { permissions: { defaultMode: "dontAsk" } } }, modo: "default", prompt: "touch", politica: "allow" },
  { id: "meta-no-bypass", oQueMuda: "só allowDangerouslySkipPermissions:false", cwd: T, options: { allowDangerouslySkipPermissions: false }, tentarModos: ["bypassPermissions", "dontAsk"] },
  { id: "meta-disable-bypass", oQueMuda: "só settings.permissions.disableBypassPermissionsMode:disable no _meta; tenta bypass e roda touch recusando pedidos", cwd: T, options: { settings: { permissions: { disableBypassPermissionsMode: "disable" } } }, tentarModos: ["bypassPermissions"], prompt: "touch", politica: "reject" },
  { id: "setting-sources-vazio", oQueMuda: "só settingSources:[] (sem settings do usuário/projeto)", cwd: T, options: { settingSources: [] }, prompt: "ok" },
  { id: "arquivo-dontask", oQueMuda: "settings.local.json do cwd com defaultMode:dontAsk", cwd: WT(2), arquivoSettings: { permissions: { defaultMode: "dontAsk" } } },
  { id: "arquivo-acceptedits-sem-bypass", oQueMuda: "settings.local.json do cwd com defaultMode:acceptEdits e disableBypassPermissionsMode:disable", cwd: WT(3), arquivoSettings: { permissions: { defaultMode: "acceptEdits", disableBypassPermissionsMode: "disable" } }, tentarModos: ["bypassPermissions"] },
];

const so = process.argv.slice(2);
const casos = so.length ? CASOS.filter((c) => so.includes(c.id)) : CASOS;

const rawInits = (h: Harness, id: string) =>
  h.rawSdkMessages(id).filter((m) => m.message?.type === "system" && m.message?.subtype === "init").map((m) => m.message);
const brief = (m: any) =>
  m
    ? { temBash: (m.tools as string[]).includes("Bash"), nTools: m.tools?.length, permissionMode: m.permissionMode, model: m.model, mcp_servers: m.mcp_servers?.map((s: any) => s.name), slash_commands: m.slash_commands?.length, plugins: m.plugins?.length, skills: m.skills?.length, agents: m.agents?.length }
    : null;
const modoCfg = (resp: any) => {
  const o = (resp?.configOptions ?? []).find((x: any) => x.id === "mode");
  return o ? { currentValue: o.currentValue, values: (o.options ?? []).map((v: any) => v.value) } : null;
};

const resultados: Record<string, unknown> = {};
for (const c of casos) {
  const arq = c.arquivoSettings ? join(c.cwd, ".claude", "settings.local.json") : undefined;
  if (arq) {
    mkdirSync(join(c.cwd, ".claude"), { recursive: true });
    writeFileSync(arq, JSON.stringify(c.arquivoSettings, null, 2));
  }
  const marca = join(c.cwd, `bash-${c.id}.txt`);
  rmSync(marca, { force: true });
  try {
    resultados[c.id] = await withAdapter(`s10-${c.id}`, {}, async (h) => {
      await h.cx.request(methods.agent.initialize, INIT_PARAMS as never);
      const r: any = (await h.cx.request(methods.agent.session.new, {
        cwd: c.cwd,
        mcpServers: [],
        _meta: { claudeCode: { emitRawSDKMessages: [{ type: "system", subtype: "init" }], ...(c.options ? { options: c.options } : {}) } },
      } as never)) as any;
      const sessionId = r.sessionId as string;
      const out: any = { oQueMuda: c.oQueMuda, catalogo: modoCfg(r) };
      if (c.prompt) out.barato = await pickCheap(h, sessionId, r);
      out.tentativas = {};
      for (const m of c.tentarModos ?? []) {
        try {
          const resp = await h.cx.request(methods.agent.session.setConfigOption, { sessionId, configId: "mode", value: m } as never);
          out.tentativas[m] = { aceito: true, depois: modoCfg(resp) };
        } catch (e) {
          out.tentativas[m] = { aceito: false, erro: String((e as Error).message).slice(0, 300) };
        }
      }
      if (c.modo) {
        const resp = await h.cx.request(methods.agent.session.setConfigOption, { sessionId, configId: "mode", value: c.modo } as never);
        out.modoAplicado = modoCfg(resp);
      }
      if (c.prompt) {
        h.permPolicy = (req) => (h.log.write({ ev: "perm_payload", req }), { pick: c.politica ?? "allow" });
        const n0 = h.permissions.length;
        const texto =
          c.prompt === "touch"
            ? `Use your Bash tool to run exactly this shell command: \`touch bash-${c.id}.txt\`. Do not use any other tool to create the file. Then reply DONE. If you have no Bash tool, or the command is denied or rejected, reply exactly NO_BASH followed by the reason in one line.`
            : "Reply with the single word ok.";
        const p = await h.prompt(sessionId, texto, { tag: c.id });
        const ups = h.updates(sessionId, p.from);
        out.prompt = { ms: p.ms, stopReason: p.stopReason, usage: p.usage, text: p.text.slice(0, 300) };
        out.pedidosDePermissao = h.permissions.slice(n0).map((q) => ({ titulo: q.toolCall?.title, kind: q.toolCall?.kind }));
        out.toolCalls = ups
          .filter((u) => u.update.sessionUpdate === "tool_call" || (u.update.sessionUpdate === "tool_call_update" && u.update.status))
          .map((u) => ({ tipo: u.update.sessionUpdate, titulo: u.update.title, status: u.update.status }));
        out.inits = rawInits(h, sessionId).map(brief);
      }
      out.arquivoCriado = existsSync(marca);
      return out;
    });
  } catch (e) {
    resultados[c.id] = { oQueMuda: c.oQueMuda, erro: String((e as Error).message ?? e).slice(0, 500) };
  } finally {
    if (arq) rmSync(join(c.cwd, ".claude"), { recursive: true, force: true });
  }
  console.log(c.id, JSON.stringify(resultados[c.id]));
}

const sufixo = so.length ? `-${so.join("+")}` : "";
writeFileSync(join(OUT, `s10-summary${sufixo}.json`), JSON.stringify(resultados, null, 2));
