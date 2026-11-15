import * as acp from '@agentclientprotocol/sdk/unstable';
import type { Agent } from './agent.ts';
import { MODEL } from './paths.ts';

export async function initialize(ag: Agent) {
  return ag.a.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: 'otheater-spike', version: '0.0.0' },
  });
}

export async function newSession(ag: Agent, cwd: string, mcpUrl?: string, mcpName = 'otheater') {
  return ag.a.request(acp.methods.agent.session.new, {
    cwd,
    mcpServers: mcpUrl ? [{ type: 'http', name: mcpName, url: mcpUrl, headers: [] }] : [],
  });
}

export async function setOption(ag: Agent, sessionId: string, configId: string, value: string) {
  return ag.a.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
}

/** Seleciona o modelo barato e esforço baixo quando houver; devolve as opções finais. */
export async function pickCheap(ag: Agent, sessionId: string) {
  const r1 = await setOption(ag, sessionId, 'model', MODEL);
  const eff = (r1.configOptions as any[]).find((o) => o.id === 'effort');
  let r2 = r1;
  const values = (eff?.options ?? []).map((o: any) => o.value);
  const effort = ['low', 'minimal'].find((e) => values.includes(e));
  if (eff && effort) r2 = await setOption(ag, sessionId, 'effort', effort);
  return { afterModel: r1.configOptions, final: r2.configOptions, effortValues: values };
}

export function cur(opts: any[], id: string) {
  return opts.find((o) => o.id === id)?.currentValue;
}
