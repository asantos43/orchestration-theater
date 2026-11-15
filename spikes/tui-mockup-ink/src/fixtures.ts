// Dados ilustrativos do mockup (os mesmos de docs/framework-ideas/mockup/tui-render.js), separados dos componentes.
// Num produto real, isto viria do daemon pelo packages/client (snapshot + eventos). Aqui é só leitura.

export type TabId = 'geral' | 'traj' | 'consumo' | 'config' | 'plugins';
export const TAB_NAMES: Record<TabId, string> = { geral: 'Visão geral', traj: 'Trajetórias', consumo: 'Consumo', config: 'Configurações', plugins: 'Plugins' };
export const TAB_ORDER: TabId[] = ['geral', 'traj', 'consumo', 'config', 'plugins'];

/** [marca, cor, nome, estado, letra do trilho] */
export type Cenario = readonly [mark: string, k: string, name: string, state: string, letter: string];
export const CEN: Cenario[] = [
  ['●', 'acc', 'loja-api', '#14 exec', 'L'],
  ['!', 'warn', 'relatorio-mensal', 'você', 'R'],
  ['✗', 'err', 'app-mobile', 'crít 2/2', 'A'],
  ['○', 'dim', 'pesquisa-acp', 'ocioso', 'P'],
  ['✓', 'ok', 'migracao-db', '#9 ok', 'M'],
];

/** [nome, rótulo, % da janela de 5 h, cor, % da janela de 7 dias (null = sem cota semanal), reset de 5 h, reset de 7 dias] */
export type Sub = readonly [name: string, label: string, p5: number, k: string, p7: number | null, r5?: string, r7?: string];
export const SUBS: Sub[] = [
  ['cc/empresa', '5h 62%', 62, 'ok', 31, '11:30', 'ter 09:00'],
  ['cc/pessoal', '5h 91% !', 91, 'warn', 58, '10:05', 'seg 14:20'],
  ['cx/conta-1', '5h 34%', 34, 'ok', 22, '12:10', 'qui 21:00'],
  ['oc/minimax-api', 'US$ 3,20', 16, 'acc', null],
  ['oc/local', '1/2 slots', 50, 'acc', null],
];

export interface Msg { kind: 'you' | 'orq' | 'sys'; who: string; time: string; text: string; k?: string }
export const MSGS: Msg[] = [
  { kind: 'you', who: 'você', time: '09:12', text: 'Quero login OAuth com Google e GitHub na API, com testes de ponta a ponta. Pode abrir PR no final.' },
  { kind: 'orq', who: 'diretor', time: '09:12', text: 'Entendido. Abri a peça #14 no projeto loja-api e mandei a necessidade para o Autor. Aviso quando o plano passar pelo Revisor.' },
  { kind: 'sys', who: 'autor', time: '09:19', text: 'Opus · alto entregou o plano (7 passos)', k: 'ok' },
  { kind: 'sys', who: 'revisor', time: '09:23', text: 'Codex · alto aprovou na 1ª tentativa', k: 'ok' },
  { kind: 'sys', who: 'roteiro', time: '09:27', text: '5 demandas · D2 e D3 em paralelo', k: 'ok' },
  { kind: 'sys', who: 'ator', time: '09:41', text: 'D1 concluída por codex-sol-high@codex/conta-1', k: 'sys' },
  { kind: 'sys', who: 'seleção', time: '09:42', text: 'D3: codex-sol-high@codex/conta-1 sem vaga → claude-sonnet-medium@claude-code/empresa', k: 'warn' },
  { kind: 'orq', who: 'diretor', time: '09:42', text: 'D1 pronta. D2 (fluxo OAuth) e D3 (middleware de sessão) estão rodando em worktrees separadas. D4 (testes e2e) começa quando as duas terminarem.' },
];

export const CHAT_TITLE = 'Chat · Orquestrador (claude-haiku-low@claude-code/empresa)';
export const PIECE_TITLE = 'Peça #14 · Login OAuth (Google e GitHub) na API';
export const DECISION_TEXT = 'O Ator da D2 precisa de credenciais de teste do Google para validar o callback. Uso um mock do provedor agora ou espero você configurar?';
export const DECISION_OPTS = ['Usar mock', 'Vou configurar'];
export const PLACEHOLDER = ' Fale com o Orquestrador…';

export const DAEMON = 'daemon 127.0.0.1:7420 ●';
export const BASE_HINTS: [string, string][] = [['^B', 'Lateral'], ['^J', 'Painel'], ['^←/^→', 'Largura do chat'], ['^T', 'Abrir aba'], ['^W', 'Fechar aba'], ['Tab', 'Foco'], ['F5', 'Config'], ['^K', 'Comandos'], ['^Q', 'Sair']];
export const FOCUS_HINTS: [string, string][] = [['^J', 'Reabrir painel'], ['^B', 'Lateral'], ['^T', 'Abrir aba'], ['F5', 'Config'], ['^K', 'Comandos'], ['^Q', 'Sair']];

/* ---- Visão geral ---- */
export const DEMANDAS: readonly [mark: string, k: string, name: string, exec: string][] = [
  ['✓', 'ok', 'D1 Usuário e migração', 'codex-sol-high@codex/conta-1'],
  ['▶', 'acc', 'D2 Fluxo OAuth · 18/30m', 'codex-sol-high@codex/conta-1 !'],
  ['▶', 'acc', 'D3 Middleware · 7/20m', 'claude-sonnet-medium@claude-code/empresa'],
  ['○', 'dim', 'D4 Testes e2e ← D2, D3', ''],
  ['○', 'dim', 'D5 Documentação · fila', ''],
];
// Conteúdo das seções que o mockup deixa recolhidas: inventado só para o spike ter o que mostrar ao expandir.
export const EVENTOS: readonly [time: string, text: string, k: string][] = [
  ['09:42', 'seleção: D3 sem vaga em cx/conta-1, usou cc/empresa', 'warn'],
  ['09:41', 'D1 concluída (codex-sol-high@codex/conta-1)', 'ok'],
  ['09:43', 'D2: pergunta ao Produtor (credenciais do Google)', 'warn'],
  ['09:44', 'D2: run_tests("auth") com 1 falha', 'err'],
  ['09:44', 'D3: edit src/auth/session.ts', 'dim'],
  ['09:45', 'cc/pessoal passou de 90% da janela de 5 h', 'warn'],
];
export const FONTES: readonly [name: string, how: string][] = [
  ['cc/empresa', 'cabeçalhos de limite da API (ilustrativo)'],
  ['cx/conta-1', 'limites devolvidos pelo cliente (ilustrativo)'],
  ['oc/minimax-api', 'consulta de saldo (ilustrativo)'],
];

/* ---- Trajetórias ---- */
export const ATTEMPTS: readonly [title: string, sub: string][] = [
  ['D2 · tentativa 1', 'codex-sol-high@codex/conta-1 · 46 passos'],
  ['D3 · tentativa 1', 'claude-sonnet-medium@claude-code/empresa · 21'],
  ['D1 · tentativa 1', 'concluída'],
  ['Roteirista', 'concluída'],
  ['Revisor', 'concluída'],
  ['Autor', 'concluída'],
];
export interface Step { t: string; kind: string; kk: string; text: string; detail?: [string, string][]; open?: boolean }
export const STEPS: Step[] = [
  { t: '09:42:30', kind: 'contexto', kk: 'sys', text: 'regras → papel ator → contrato C-2 → demanda D2' },
  { t: '09:42:41', kind: 'read', kk: 'acc', text: 'src/models/user.ts · 86 linhas' },
  { t: '09:42:44', kind: 'mcp', kk: 'ok', text: 'ler_contrato("C-2")' },
  { t: '09:43:02', kind: 'edit', kk: 'acc', text: 'src/auth/oauth.ts  +118 −0', open: true, detail: [
    ['+ export class OAuthService {', 'add'],
    ['+   constructor(private providers, private users) {}', 'add'],
    ["+   authorize(provider: 'google' | 'github', state): URL { … }", 'add'],
    ['+   async callback(provider, code, state): Promise<Session>', 'add'],
    ['+ }', 'add'],
  ] },
  { t: '09:43:20', kind: 'casca', kk: 'ok', text: 'install_deps() · fila de pesados (2º) · 14 s · ok' },
  { t: '09:43:52', kind: 'mcp', kk: 'warn', text: 'perguntar_produtor("credenciais do Google")' },
  { t: '09:44:10', kind: 'casca', kk: 'err', text: 'run_tests("auth") → 11 ok, 1 falha', open: true, detail: [
    ['✗ oauth.callback › google › troca código por token', 'err'],
    ['  GOOGLE_CLIENT_ID ausente no ambiente de teste', 'dim'],
    ['  saída truncada pela casca: 1.204 → 40 linhas', 'dim'],
  ] },
  { t: '09:44:30', kind: 'edit', kk: 'acc', text: 'tests/auth/github.e2e.ts  +64 −0' },
];
export const TRAJ_HEAD = ['D2 · Fluxo OAuth', ' · 182k entrada (71% cache) · 9,4k saída'] as const;
export const TRAJ_FOOT_LINE = ['● em curso', ' · 18/30 min · WIP automático no timeout'] as const;

/* ---- Configurações ---- */
export type ExecStatus = 'ok' | 'pool cheio' | 'inválido';
export interface Role { name: string; execs: readonly [name: string, status: ExecStatus][]; rule: 'próximo' | 'esperar'; closed?: boolean }
export const ROLES: Role[] = [
  { name: 'Diretor (Orquestrador)', execs: [['claude-haiku-low@claude-code/empresa', 'ok'], ['codex-luna-low@codex/conta-1', 'ok'], ['gemma4-low@opencode/local', 'ok']], rule: 'próximo' },
  { name: 'Autor', execs: [['claude-opus-high@claude-code/empresa', 'ok'], ['codex-sol-high@codex/conta-1', 'ok']], rule: 'próximo' },
  { name: 'Revisor', execs: [['codex-sol-high@codex/conta-1', 'ok'], ['claude-opus-high@claude-code/empresa', 'ok']], rule: 'próximo' },
  { name: 'Roteirista', execs: [['claude-opus-high@claude-code/empresa', 'ok'], ['codex-sol-high@codex/conta-1', 'ok']], rule: 'próximo', closed: true },
  { name: 'Ator', execs: [['codex-sol-high@codex/conta-1', 'pool cheio'], ['claude-sonnet-medium@claude-code/empresa', 'ok'], ['minimax-m2-medium@opencode/minimax-api', 'ok'], ['codex-luna-medium@codex-pessoal', 'inválido']], rule: 'próximo' },
  { name: 'Crítico', execs: [['claude-opus-high@claude-code/empresa', 'ok'], ['codex-sol-high@codex/conta-1', 'ok']], rule: 'esperar' },
];
export const CONFIG_SUBS = ['Assinaturas', 'Executores', 'Papéis', 'Limites'] as const;

export const ROLES_FOOT: [string, string][] = [['⇧↑↓', 'reordenar'], ['r', 'regra'], ['s', 'salvar'], ['enter', 'recolher']];
export const GERAL_FOOT: [string, string][] = [['enter', 'recolher/expandir seção'], ['^W', 'fechar aba']];
export const TRAJ_FOOT: [string, string][] = [['enter', 'expandir passo'], ['f', 'filtrar'], ['d', 'diff'], ['F', 'seguir ao vivo']];
