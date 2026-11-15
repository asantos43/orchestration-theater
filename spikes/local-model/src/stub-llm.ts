// Servidor OpenAI-compatível falso: grava o corpo de cada requisição e responde "ok".
// Serve para medir quantos tokens o OpenCode envia (prompt de sistema + ferramentas) sem gastar inferência.
// Uso: node src/stub-llm.ts <porta> <arquivo-de-saida.jsonl>
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const [port = '47510', file = 'out/stub-requests.jsonl'] = process.argv.slice(2);
writeFileSync(file, '');
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  appendFileSync(file, JSON.stringify({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null }) + '\n');
  if (req.url?.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const mk = (delta: object, fin: string | null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
    res.write(mk({ role: 'assistant', content: 'ok' }, null));
    res.write(mk({}, 'stop'));
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } else res.writeHead(404).end();
}).listen(Number(port), '127.0.0.1');
