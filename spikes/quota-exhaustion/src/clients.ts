// Definição de cada cliente: como subir o adaptador contra o mock, perfil isolado e o que configurar na sessão.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AdapterSpec } from './lib.ts';
import { FAKE_KEY, HERE, PORTS, PROFILES, SCRATCH, cleanEnv } from './lib.ts';
import type { Action, Flavor } from './mock.ts';

export type ClientName = 'claude' | 'codex' | 'opencode';

export interface ClientDef {
  name: ClientName;
  flavor: Flavor;
  port: number;
  /** processo adaptador contra o mock; `tag` separa logs; `profile` é a pasta isolada */
  spec(tag: string): AdapterSpec;
  /** configura modelo/modo depois de session/new ou session/load */
  configure(a: Adapter, sessionId: string, resp: any): Promise<Record<string, unknown>>;
  /** ação do mock que faz o cliente executar uma ferramenta de leitura inofensiva (para "cota acaba no meio da tarefa") */
  toolAction(cwd: string): Action;
  /** chamada após initialize (ex.: authenticate) */
  afterInit?(a: Adapter): Promise<unknown>;
}

const adapterJs = (pkg: string) => join(HERE, 'node_modules/@agentclientprotocol', pkg, 'dist/index.js');

async function tryOpt(a: Adapter, sid: string, id: string, value: string, applied: Record<string, unknown>) {
  try {
    await a.setOption(sid, id, value);
    applied[id] = value;
  } catch (e: any) {
    applied[id] = 'ERRO: ' + String(e?.message ?? e);
  }
}

export const claude: ClientDef = {
  name: 'claude',
  flavor: 'anthropic',
  port: PORTS.claude,
  spec(tag) {
    const cfg = join(PROFILES, 'claude-quota'); // vazio, sem login: só ANTHROPIC_API_KEY falsa
    mkdirSync(cfg, { recursive: true });
    return {
      name: tag,
      cmd: process.execPath,
      args: [adapterJs('claude-agent-acp')],
      env: cleanEnv({ CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORTS.claude}`, ANTHROPIC_API_KEY: FAKE_KEY }),
    };
  },
  async configure(a, sid) {
    const applied: Record<string, unknown> = {};
    await tryOpt(a, sid, 'mode', 'default', applied);
    await tryOpt(a, sid, 'model', 'haiku', applied);
    await tryOpt(a, sid, 'effort', 'low', applied);
    return applied;
  },
  toolAction: (cwd) => ({ kind: 'tool', name: 'Read', input: { file_path: join(cwd, 'README.txt') } }),
};

function codexHome() {
  const home = join(PROFILES, 'codex-quota');
  mkdirSync(home, { recursive: true });
  // provedor falso: Responses API local, chave por variável de ambiente (falsa).
  // Os valores de retentativa ficam nos padrões do Codex (não definidos aqui) para medir o comportamento padrão.
  writeFileSync(
    join(home, 'config.toml'),
    [
      'model = "mock-1"',
      'model_provider = "mock"',
      'cli_auth_credentials_store = "file"',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      '',
      '[model_providers.mock]',
      'name = "Mock local"',
      `base_url = "http://127.0.0.1:${PORTS.codex}/v1"`,
      'env_key = "MOCK_API_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'),
  );
  return home;
}

export const codex: ClientDef = {
  name: 'codex',
  flavor: 'responses',
  port: PORTS.codex,
  spec(tag) {
    return {
      name: tag,
      cmd: process.execPath,
      args: [adapterJs('codex-acp')],
      env: cleanEnv({
        CODEX_HOME: codexHome(),
        CODEX_PATH: join(HERE, 'node_modules/@openai/codex/bin/codex.js'),
        MOCK_API_KEY: FAKE_KEY,
      }),
    };
  },
  async configure(a, sid, resp) {
    const applied: Record<string, unknown> = {};
    await tryOpt(a, sid, 'mode', 'workspace-write', applied);
    return applied;
  },
  toolAction: (cwd) => ({ kind: 'tool', name: 'exec_command', input: { cmd: 'cat README.txt', workdir: cwd } }),
};

export function opencodeConfig() {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock-1',
    small_model: 'mock/mock-1',
    autoupdate: false,
    share: 'disabled',
    provider: {
      mock: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Mock local',
        options: { baseURL: `http://127.0.0.1:${PORTS.opencode}/v1`, apiKey: FAKE_KEY },
        models: { 'mock-1': { name: 'Mock 1', tool_call: true, limit: { context: 128000, output: 8192 } } },
      },
    },
    permission: { edit: 'allow', bash: 'allow', webfetch: 'deny' },
    mcp: {},
    lsp: false,
    formatter: false,
  });
}

export const opencode: ClientDef = {
  name: 'opencode',
  flavor: 'chat',
  port: PORTS.opencode,
  spec(tag) {
    const root = join(PROFILES, 'opencode-quota');
    for (const d of ['data', 'config', 'cache', 'state']) mkdirSync(join(root, d), { recursive: true });
    return {
      name: tag,
      cmd: 'opencode',
      args: ['acp'],
      env: cleanEnv({
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_CACHE_HOME: join(root, 'cache'),
        XDG_STATE_HOME: join(root, 'state'),
        OPENCODE_DB: join(root, 'data', 'opencode.db'),
        OPENCODE_CONFIG_CONTENT: opencodeConfig(),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
      }),
    };
  },
  async configure(a, sid) {
    const applied: Record<string, unknown> = {};
    await tryOpt(a, sid, 'model', 'mock/mock-1', applied);
    return applied;
  },
  toolAction: (cwd) => ({ kind: 'tool', name: 'bash', input: { command: 'cat README.txt', description: 'ler o README', workdir: cwd } }),
};

export const CLIENTS: Record<ClientName, ClientDef> = { claude, codex, opencode };
void SCRATCH;
