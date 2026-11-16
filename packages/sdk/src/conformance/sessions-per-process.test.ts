// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { describeSessionsReport, probeSessionsPerProcess } from './sessions-per-process.js';

// A tiny ACP agent as a Node script (no real client): `limit` sessions are accepted, the next
// ones get an error; `die` ends the process at the Nth `session/new`.
const agent = (limit: number, die = 0): string => `
const rl = require('node:readline').createInterface({ input: process.stdin });
let n = 0;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  const reply = (r) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...r }) + '\\n');
  if (m.method === 'initialize') return reply({ result: { protocolVersion: 1 } });
  if (m.method === 'session/new') {
    n += 1;
    if (${String(die)} === n) process.exit(1);
    if (n > ${String(limit)}) return reply({ error: { code: -32000, message: 'too many sessions' } });
    return reply({ result: { sessionId: 's' + n, configOptions: [{ id: 'model' }, { id: 'effort' }] } });
  }
});
`;

const probe = (script: string, sessions: number) => ({
  cmd: process.execPath,
  args: ['-e', script],
  cwd: process.cwd(),
  env: {},
  sessions,
  timeoutMs: 5_000,
});

describe('probeSessionsPerProcess', () => {
  it('reports that the client accepted every session, with distinct ids and its options', async () => {
    const report = await probeSessionsPerProcess(probe(agent(10), 3));
    expect(report).toMatchObject({
      requested: 3,
      accepted: 3,
      distinctSessionIds: 3,
      failures: [],
      configOptionIds: ['model', 'effort'],
      processAlive: true,
    });
    expect(describeSessionsReport('fake', report)).toContain('accepted=3');
  });

  it('reports the refusals of a client that takes fewer sessions than asked', async () => {
    const report = await probeSessionsPerProcess(probe(agent(2), 4));
    expect(report.accepted).toBe(2);
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0]).toContain('too many sessions');
    expect(report.processAlive).toBe(true);
  });

  it('reports a process that dies in the middle', async () => {
    const report = await probeSessionsPerProcess(probe(agent(10, 2), 4));
    expect(report.accepted).toBe(1);
    expect(report.processAlive).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
  });
});
