// Item 9: perfil isolado. CODEX_HOME numa pasta vazia da scratchpad com cli_auth_credentials_store="file".
// Nao faz login e nao le credenciais. Registra o que o adaptador diz em initialize e session/new.
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { Adapter, SCRATCH, WT, result, sleep } from './lib.ts';

const home = join(SCRATCH, 'codex-home-empty');
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n');

// sem chaves de API herdadas, para o teste ser so do perfil
const env: Record<string, string> = { CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '' };
const a = Adapter.start({ name: 's6-profile', env });
const out: Record<string, unknown> = { codexHomeFilesBefore: readdirSync(home) };
try {
  const init = await a.initialize();
  out.initialize = init;
} catch (e) {
  out.initializeError = String(e);
}
try {
  const s = await a.agent.request(acp.methods.agent.session.new, { cwd: WT(1), mcpServers: [] });
  out.sessionNew = s;
} catch (e) {
  out.sessionNewError = e instanceof Error ? { message: e.message, ...(e as object) } : String(e);
}
await sleep(1500);
out.stderr = a.stderrText.slice(0, 1500);
out.codexHomeFilesAfter = readdirSync(home);
result('s6-profile-empty-codex-home', out);
await a.stop();
process.exit(0);
