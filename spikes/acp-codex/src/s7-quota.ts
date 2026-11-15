// Item 8 (complemento): consulta direta `account/rateLimits/read` no `codex app-server` (stdio), sem prompt de modelo.
// Usa o CODEX_HOME padrao do dono; nao le auth.json e nao chama account/read (que traria e-mail).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BUNDLED_CODEX, result, jsonl, sleep } from './lib.ts';

const log = jsonl('s7-quota.jsonl');
const child = spawn(process.execPath, [BUNDLED_CODEX, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map<number, (m: any) => void>();
const notifications: string[] = [];
let stderr = '';
child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
createInterface({ input: child.stdout! }).on('line', (l) => {
  let m: any;
  try {
    m = JSON.parse(l);
  } catch {
    return;
  }
  log({ dir: 'in', msg: m });
  if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)!(m);
  else if (m.method) notifications.push(m.method);
});
let n = 0;
const send = (method: string, params?: unknown) =>
  new Promise<any>((res) => {
    const id = ++n;
    pending.set(id, res);
    const msg = { jsonrpc: '2.0', id, method, params };
    log({ dir: 'out', msg });
    child.stdin!.write(JSON.stringify(msg) + '\n');
  });
const notify = (method: string, params?: unknown) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const t0 = Date.now();
const init = await Promise.race([send('initialize', { clientInfo: { name: 'otheater-spike', title: 'spike', version: '0.0.0' } }), sleep(15000).then(() => 'timeout')]);
notify('initialized');
const rl = await Promise.race([send('account/rateLimits/read'), sleep(20000).then(() => 'timeout')]);
// nunca registrar o e-mail: o resultado de rateLimits nao o traz, mas filtramos por seguranca
const redacted = JSON.parse(JSON.stringify(rl, (k, v) => (/email/i.test(k) ? '[omitido]' : v)));
result('app-server-rateLimits-read', { ms: Date.now() - t0, init: typeof init === 'string' ? init : { keys: Object.keys(init.result ?? init) }, rateLimits: redacted, notifications, stderr: stderr.slice(0, 500) });
child.kill('SIGTERM');
await sleep(500);
if (child.exitCode === null) child.kill('SIGKILL');
process.exit(0);
