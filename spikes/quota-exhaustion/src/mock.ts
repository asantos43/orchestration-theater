// Servidor falso (mock) local que imita a API de cada provedor, com cota que "acaba" por roteiro.
// Três sabores: `anthropic` (Messages API, SSE), `responses` (OpenAI Responses API, SSE, usada pelo Codex)
// e `chat` (OpenAI chat completions, SSE, usada pelo OpenCode com @ai-sdk/openai-compatible).
//
// Segurança: o mock NÃO registra cabeçalhos de autenticação (Authorization, x-api-key, cookies). Só uma lista
// fixa de cabeçalhos inofensivos entra no log. A chave usada nos testes é falsa, gerada pelo spike.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

export type Flavor = 'anthropic' | 'responses' | 'chat';

export type Action =
  | { kind: 'ok'; chunks?: number; delayMs?: number; label?: string }
  /** a resposta pede uma ferramenta (o cliente executa e manda o resultado na requisição seguinte) */
  | { kind: 'tool'; input?: Record<string, unknown>; name?: string; preface?: string }
  /** HTTP 429 antes do primeiro byte do corpo SSE */
  | { kind: '429'; retryAfter?: number | null; resetInSec?: number; headers?: Record<string, string>; plain?: { code: string; message: string } }
  /** outro status HTTP (500, 529...) */
  | { kind: 'http'; status: number; retryAfter?: number | null; body?: unknown }
  /** corta o stream depois de `after` pedaços de texto: por evento de erro do provedor ou derrubando o socket */
  | { kind: 'cut'; after: number; how: 'error' | 'destroy' | 'failed'; delayMs?: number; errorType?: string; message?: string }
  /** 200 e depois nada: stream parado (para medir timeouts de ociosidade) */
  | { kind: 'stall'; after?: number };

export interface LogEntry {
  i: number;
  tMs: number;
  iso: string;
  method: string;
  path: string;
  main: boolean;
  stream: boolean | null;
  model: string | null;
  nInput: number | null;
  lastKind: string | null;
  tools: string[];
  retryCount: string | null;
  ua: string | null;
  action: string;
  status: number;
  /** forma do histórico enviado (papéis e tipos de bloco), sem texto */
  hist?: string[];
  /** marcadores (mock.markers) encontrados em qualquer lugar do corpo da requisição */
  hits?: string[];
  note?: string;
}

const SAFE_HEADERS = ['user-agent', 'x-stainless-retry-count', 'x-stainless-timeout', 'anthropic-version', 'content-type', 'openai-beta', 'x-client-request-id', 'originator', 'session_id', 'x-codex-turn-state'];

export class Mock {
  readonly flavor: Flavor;
  readonly port: number;
  readonly log: LogEntry[] = [];
  /** ações consumidas, uma por requisição "principal" (as que trazem ferramentas) */
  plan: Action[] = [];
  /** ação quando o roteiro acaba */
  fallback: Action = { kind: 'ok' };
  /** ação para requisições auxiliares (título, sondagem de cota...): sempre resposta curta normal por padrão */
  auxAction: Action = { kind: 'ok', chunks: 1, delayMs: 0, label: 'aux' };
  /** cada ação do roteiro é aplicada a quantas requisições principais seguidas (para 429 repetido, use o fallback) */
  mainCount = 0;
  /** textos procurados no corpo de cada requisição (para saber se o histórico trouxe o texto parcial, o pedido etc.) */
  markers: string[] = [];
  readonly t0 = Date.now();
  private server!: Server;
  private logFile?: string;
  /** corpos da última requisição principal, só estrutura (nada de cabeçalho) */
  lastMainBody: any = null;
  /** nomes completos das ferramentas vistas (primeira requisição principal) */
  toolsSeen: string[] = [];
  openSockets = new Set<import('node:net').Socket>();

  constructor(flavor: Flavor, port: number, logFile?: string) {
    this.flavor = flavor;
    this.port = port;
    this.logFile = logFile;
    if (logFile) writeFileSync(logFile, '');
  }

  setPlan(plan: Action[], fallback: Action = { kind: 'ok' }) {
    this.plan = [...plan];
    this.fallback = fallback;
    this.mainCount = 0;
  }
  /** só troca o que acontece daqui para a frente (sem zerar o log) */
  setFallback(fallback: Action) {
    this.plan = [];
    this.fallback = fallback;
  }
  clearLog() {
    this.log.length = 0;
    this.mainCount = 0;
  }
  mainLog() {
    return this.log.filter((l) => l.main);
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.openSockets.add(s);
      s.on('close', () => this.openSockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(this.port, '127.0.0.1', r));
    return this;
  }
  async stop() {
    for (const s of this.openSockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private record(e: Omit<LogEntry, 'i' | 'tMs' | 'iso'>) {
    const entry: LogEntry = { i: this.log.length + 1, tMs: Date.now() - this.t0, iso: new Date().toISOString(), ...e };
    this.log.push(entry);
    if (this.logFile) appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    return entry;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const path = (req.url ?? '/').split('?')[0]!;
    const method = req.method ?? 'GET';
    const safe: Record<string, string> = {};
    for (const h of SAFE_HEADERS) if (req.headers[h]) safe[h] = String(req.headers[h]);

    // endpoints de controle (usados por quem roda o mock como processo avulso)
    const ep = this.endpoints(path);
    if (ep === 'models' && method === 'GET') {
      this.record({ method, path, main: false, stream: null, model: null, nInput: null, lastKind: null, tools: [], retryCount: null, ua: safe['user-agent'] ?? null, action: 'models', status: 200 });
      return json(res, 200, this.flavor === 'anthropic' ? { data: [], has_more: false, first_id: null, last_id: null } : { object: 'list', data: [{ id: 'mock-1', object: 'model' }] });
    }
    if (ep !== 'generate') {
      this.record({ method, path, main: false, stream: null, model: null, nInput: null, lastKind: null, tools: [], retryCount: null, ua: safe['user-agent'] ?? null, action: 'other', status: 404 });
      return json(res, 404, { error: { message: 'mock: caminho desconhecido ' + path } });
    }

    const info = this.describe(body);
    const main = info.tools.length > 0;
    let action: Action;
    let which: string;
    if (main) {
      this.mainCount++;
      if (this.mainCount === 1) {
        this.toolsSeen = info.tools;
        this.lastMainBody = body;
      }
      action = this.plan.length ? this.plan.shift()! : this.fallback;
      which = `main#${this.mainCount}:${action.kind}`;
    } else {
      action = this.auxAction;
      which = `aux:${action.kind}`;
    }
    const entry = this.record({
      method,
      path,
      main,
      stream: info.stream,
      model: info.model,
      nInput: info.nInput,
      lastKind: info.lastKind,
      tools: main ? info.tools.slice(0, 40) : [],
      retryCount: safe['x-stainless-retry-count'] ?? null,
      ua: safe['user-agent'] ?? null,
      action: which,
      status: 200,
      hist: info.hist,
      hits: this.markers.filter((m) => raw.includes(m)),
    });
    try {
      await this.respond(res, action, info, entry);
    } catch (e) {
      entry.note = 'erro ao responder: ' + String((e as Error).message);
    }
  }

  private endpoints(path: string): 'generate' | 'models' | 'other' {
    if (this.flavor === 'anthropic') {
      if (path === '/v1/messages') return 'generate';
      if (path === '/v1/models') return 'models';
    } else if (this.flavor === 'responses') {
      if (path === '/v1/responses') return 'generate';
      if (path === '/v1/models') return 'models';
    } else {
      if (path === '/v1/chat/completions') return 'generate';
      if (path === '/v1/models') return 'models';
    }
    return 'other';
  }

  /** extrai só estrutura do corpo: modelo, stream, quantidade de entradas, tipo do último item, nomes das ferramentas */
  private describe(body: any) {
    const model = body?.model ?? null;
    const stream = typeof body?.stream === 'boolean' ? body.stream : null;
    let nInput: number | null = null;
    let lastKind: string | null = null;
    let tools: string[] = [];
    let hist: string[] = [];
    if (this.flavor === 'anthropic') {
      const msgs: any[] = body?.messages ?? [];
      nInput = msgs.length;
      hist = msgs.map((m) => `${m.role}:${Array.isArray(m.content) ? m.content.map((b: any) => b.type).join('+') : 'text'}`);
      const last = msgs[msgs.length - 1];
      const c = last?.content;
      lastKind = last ? `${last.role}:${Array.isArray(c) ? (c[c.length - 1]?.type ?? '?') : 'text'}` : null;
      tools = (body?.tools ?? []).map((t: any) => t.name);
    } else if (this.flavor === 'responses') {
      const inp: any[] = Array.isArray(body?.input) ? body.input : [];
      nInput = inp.length;
      hist = inp.map((i) => `${i.type ?? 'message'}${i.role ? ':' + i.role : ''}`);
      const last = inp[inp.length - 1];
      lastKind = last ? `${last.type ?? 'message'}${last.role ? ':' + last.role : ''}` : null;
      tools = (body?.tools ?? []).map((t: any) => t.name ?? t.type);
    } else {
      const msgs: any[] = body?.messages ?? [];
      nInput = msgs.length;
      hist = msgs.map((m) => `${m.role}${m.tool_calls ? ':tool_calls' : ''}`);
      const last = msgs[msgs.length - 1];
      lastKind = last ? last.role : null;
      tools = (body?.tools ?? []).map((t: any) => t.function?.name ?? t.type);
    }
    return { model, stream, nInput, lastKind, tools, hist, body };
  }

  // ---------- respostas ----------
  private async respond(res: ServerResponse, a: Action, info: ReturnType<Mock['describe']>, entry: LogEntry) {
    switch (a.kind) {
      case '429':
        entry.status = 429;
        return this.rate429(res, a);
      case 'http':
        entry.status = a.status;
        {
          const h: Record<string, string> = {};
          if (a.retryAfter != null) h['retry-after'] = String(a.retryAfter);
          return json(res, a.status, a.body ?? errBody(this.flavor, a.status === 529 ? 'overloaded_error' : 'api_error', 'mock: erro ' + a.status), h);
        }
      case 'ok':
        return this.stream(res, info, { kind: 'text', chunks: a.chunks ?? 12, delayMs: a.delayMs ?? 120 });
      case 'tool':
        return this.stream(res, info, { kind: 'tool', name: a.name, input: a.input, preface: a.preface });
      case 'cut':
        return this.stream(res, info, { kind: 'text', chunks: a.after, delayMs: a.delayMs ?? 120, cut: a });
      case 'stall':
        return this.stream(res, info, { kind: 'text', chunks: a.after ?? 3, delayMs: 120, stall: true });
    }
  }

  private rate429(res: ServerResponse, a: Extract<Action, { kind: '429' }>) {
    const resetAt = Math.floor(Date.now() / 1000) + (a.resetInSec ?? 3600);
    const h: Record<string, string> = { ...(a.headers ?? {}) };
    if (a.retryAfter !== null) h['retry-after'] = String(a.retryAfter ?? 1);
    let body: unknown;
    if (this.flavor === 'anthropic') {
      Object.assign(h, {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(resetAt),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(resetAt),
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-reset': String(resetAt + 86400),
        'anthropic-ratelimit-unified-7d-utilization': '0.25',
        'anthropic-ratelimit-unified-overage-status': 'rejected',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'overage_not_provisioned',
      });
      body = errBody('anthropic', 'rate_limit_error', 'Number of request tokens has exceeded your rate limit (mock).');
    } else if (this.flavor === 'responses' && a.plain) {
      // 429 genérico no estilo da API da OpenAI (sem `usage_limit_reached`)
      body = { error: { message: a.plain.message, type: a.plain.code, param: null, code: a.plain.code } };
    } else if (this.flavor === 'responses') {
      // formato do erro `usage_limit_reached` do backend do Codex [S: lido do codex-rs; confirmado pela leitura de strings do binário]
      body = { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached (mock).', plan_type: 'plus', resets_at: resetAt, resets_in_seconds: a.resetInSec ?? 3600 } };
      Object.assign(h, { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': String(resetAt), 'x-codex-secondary-used-percent': '20', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': String(resetAt + 86400) });
    } else {
      body = { error: { message: 'Rate limit reached (mock).', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' } };
    }
    json(res, 429, body, h);
  }

  private async stream(
    res: ServerResponse,
    info: ReturnType<Mock['describe']>,
    s: { kind: 'text'; chunks: number; delayMs: number; cut?: Extract<Action, { kind: 'cut' }>; stall?: boolean } | { kind: 'tool'; name?: string; input?: Record<string, unknown>; preface?: string },
  ) {
    const model = info.model ?? 'mock-1';
    const wantStream = info.stream !== false;
    const pieces = s.kind === 'text' ? Array.from({ length: s.chunks }, (_, i) => `PARTE-${String(i + 1).padStart(2, '0')} `) : [];
    if (s.kind === 'tool' && s.preface) pieces.push(s.preface);

    if (!wantStream) {
      // requisição sem stream (o Claude Code cai nela como reserva quando o stream falha)
      if (s.kind === 'text' && s.cut) return this.cutNonStream(res, s.cut);
      return this.nonStream(res, model, s, pieces);
    }
    const sse = new Sse(res, this.flavor);
    sse.head();
    const id = 'mock' + Math.random().toString(36).slice(2, 8);
    const textDelay = s.kind === 'text' ? s.delayMs : 0;
    const tool = s.kind === 'tool' ? this.toolCall(s, info) : null;

    sse.open(id, model, pieces.length > 0 || s.kind === 'text');
    for (let i = 0; i < pieces.length; i++) {
      sse.text(pieces[i]!);
      if (textDelay) await sleep(textDelay);
      if (s.kind === 'text' && s.cut && i + 1 === s.cut.after) {
        if (s.cut.how === 'destroy') {
          res.socket?.destroy();
          return;
        }
        sse.error(s.cut.errorType ?? 'overloaded_error', s.cut.how === 'failed', s.cut.message);
        res.end();
        return;
      }
      if (s.kind === 'text' && s.stall && i + 1 === s.chunks) {
        // fica parado sem fechar: o cliente que se vire com o timeout
        return;
      }
    }
    if (s.kind === 'text' && s.cut && s.cut.after === 0) {
      sse.error(s.cut.errorType ?? 'overloaded_error');
      res.end();
      return;
    }
    if (tool) sse.tool(tool.name, tool.input);
    sse.close(pieces.join('') + (tool ? '' : ''), tool);
    res.end();
  }

  private cutNonStream(res: ServerResponse, c: Extract<Action, { kind: 'cut' }>) {
    if (c.how === 'destroy') return void res.socket?.destroy();
    const status = c.errorType === 'rate_limit_error' ? 429 : this.flavor === 'anthropic' ? 529 : 503;
    json(res, status, errBody(this.flavor, c.errorType ?? 'overloaded_error', 'mock: sobrecarga'));
  }

  private nonStream(res: ServerResponse, model: string, s: any, pieces: string[]) {
    const text = pieces.join('');
    if (this.flavor === 'anthropic') {
      const content: any[] = [];
      if (text) content.push({ type: 'text', text });
      let stop = 'end_turn';
      if (s.kind === 'tool') {
        content.push({ type: 'tool_use', id: 'toolu_mock1', name: s.name ?? 'Read', input: s.input ?? {} });
        stop = 'tool_use';
      }
      return json(res, 200, { id: 'msg_mock', type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 7 } });
    }
    if (this.flavor === 'chat') {
      return json(res, 200, { id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
    }
    return json(res, 200, { id: 'resp_mock', object: 'response', status: 'completed', model, output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } });
  }

  /** escolhe a ferramenta e os argumentos conforme o sabor */
  private toolCall(s: { name?: string; input?: Record<string, unknown> }, info: ReturnType<Mock['describe']>) {
    if (s.name && s.input) return { name: s.name, input: s.input };
    const names = info.tools;
    if (this.flavor === 'anthropic') return { name: s.name ?? 'Read', input: s.input ?? { file_path: '/tmp/nada' } };
    if (this.flavor === 'chat') return { name: s.name ?? (names.find((n) => n === 'bash') ?? names[0] ?? 'bash'), input: s.input ?? { command: 'echo mock-tool-ok', description: 'eco' } };
    // responses (Codex): tenta achar a ferramenta de shell que o Codex expõe
    const shell = names.find((n) => /^(shell_command|exec_command|shell)$/.test(String(n))) ?? names.find((n) => /shell|exec/.test(String(n))) ?? names[0] ?? 'shell_command';
    return { name: s.name ?? String(shell), input: s.input ?? (shell === 'shell' ? { command: ['bash', '-lc', 'echo mock-tool-ok'] } : { command: 'echo mock-tool-ok' }) };
  }
}

// ---------- SSE por sabor ----------
class Sse {
  private n = 0;
  private id = '';
  private model = '';
  private acc = '';
  private openedText = false;
  private tooled = false;
  private res: ServerResponse;
  private flavor: Flavor;
  constructor(res: ServerResponse, flavor: Flavor) {
    this.res = res;
    this.flavor = flavor;
  }
  head() {
    this.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    this.res.flushHeaders();
  }
  private ev(event: string | null, data: unknown) {
    this.res.write((event ? `event: ${event}\n` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  }
  open(id: string, model: string, withText: boolean) {
    this.id = id;
    this.model = model;
    if (this.flavor === 'anthropic') {
      this.ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
      if (withText) {
        this.ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        this.openedText = true;
      }
    } else if (this.flavor === 'responses') {
      this.ev('response.created', { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model, output: [] } });
    } else {
      this.chat({ role: 'assistant', content: '' }, null);
    }
  }
  private chat(delta: unknown, finish: string | null, usage?: unknown) {
    this.ev(null, { id: this.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
  }
  text(t: string) {
    this.acc += t;
    if (this.flavor === 'anthropic') {
      this.ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
    } else if (this.flavor === 'responses') {
      if (!this.openedText) {
        this.ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
        this.ev('response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        this.openedText = true;
      }
      this.ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: t });
    } else {
      this.chat({ content: t }, null);
    }
  }
  tool(name: string, input: Record<string, unknown>) {
    this.tooled = true;
    const args = JSON.stringify(input);
    if (this.flavor === 'anthropic') {
      if (this.openedText) {
        this.ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        this.openedText = false;
      }
      this.ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_mock' + ++this.n, name, input: {} } });
      this.ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args } });
      this.ev('content_block_stop', { type: 'content_block_stop', index: 1 });
    } else if (this.flavor === 'responses') {
      this.toolItem = { id: 'fc_mock1', type: 'function_call', call_id: 'call_mock1', name, arguments: args, status: 'completed' };
      this.ev('response.output_item.added', { type: 'response.output_item.added', output_index: this.openedText ? 1 : 0, item: { ...this.toolItem, arguments: '', status: 'in_progress' } });
      this.ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_mock1', output_index: this.openedText ? 1 : 0, delta: args });
    } else {
      this.chat({ tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name, arguments: args } }] }, null);
    }
  }
  private toolItem: any = null;
  error(type: string, failed = false, message = 'mock: ' + type) {
    if (failed && this.flavor === 'responses') this.ev('response.failed', { type: 'response.failed', response: { id: this.id, object: 'response', status: 'failed', error: { code: type, message }, output: [], usage: null } });
    else if (this.flavor === 'anthropic') this.ev('error', { type: 'error', error: { type, message: 'mock: ' + type } });
    else if (this.flavor === 'responses') this.ev('error', { type: 'error', code: type, message: 'mock: ' + type, param: null });
    else this.ev(null, { error: { message: 'mock: ' + type, type, code: type } });
  }
  close(_all: string, tool: unknown) {
    const usage = { in: 12, out: 7 };
    if (this.flavor === 'anthropic') {
      if (this.openedText) this.ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      this.ev('message_delta', { type: 'message_delta', delta: { stop_reason: this.tooled ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { input_tokens: 12, output_tokens: 7 } });
      this.ev('message_stop', { type: 'message_stop' });
    } else if (this.flavor === 'responses') {
      const output: any[] = [];
      if (this.openedText) {
        const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: this.acc, annotations: [] }] };
        this.ev('response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: this.acc });
        this.ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
        output.push(item);
      }
      if (this.toolItem) {
        this.ev('response.output_item.done', { type: 'response.output_item.done', output_index: output.length, item: this.toolItem });
        output.push(this.toolItem);
      }
      this.ev('response.completed', { type: 'response.completed', response: { id: this.id, object: 'response', status: 'completed', model: this.model, output, usage: { input_tokens: usage.in, input_tokens_details: { cached_tokens: 0 }, output_tokens: usage.out, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: usage.in + usage.out } } });
    } else {
      this.chat({}, this.tooled ? 'tool_calls' : 'stop', undefined);
      this.ev(null, { id: this.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model, choices: [], usage: { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out } });
      this.ev(null, '[DONE]');
    }
  }
}

function errBody(flavor: string, type: string, message: string) {
  if (flavor === 'anthropic') return { type: 'error', error: { type, message } };
  return { error: { message, type, param: null, code: type } };
}
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startMock(flavor: Flavor, port: number, logFile?: string) {
  return new Mock(flavor, port, logFile).start();
}

// uso avulso: node src/mock.ts anthropic 47200  (sempre responde ok; serve para testar à mão)
if (import.meta.url === `file://${process.argv[1]}`) {
  const flavor = (process.argv[2] ?? 'anthropic') as Flavor;
  const port = Number(process.argv[3] ?? 47200);
  const m = await startMock(flavor, port);
  console.log(`mock ${flavor} em http://127.0.0.1:${m.port}`);
}
