// SPDX-License-Identifier: MPL-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CCUSAGE_PINNED_VERSION, CcusageSource } from './index.js';

// Test against the REAL `ccusage@20.0.48` (N118), off unless `OT_CCUSAGE_BIN` is the absolute
// path of the downloaded launcher (and its native platform package is installed beside it).
// The tool only sees what the test writes: `HOME` and the client directories are a temp folder,
// and the one fixture is a Claude Code log the test wrote itself, with no conversation text.
// The shape of the real output is [N] until this test has run once against the binary.

const bin = process.env.OT_CCUSAGE_BIN;

describe.skipIf(bin === undefined || bin.length === 0)(
  'CcusageSource against the real ccusage (OT_CCUSAGE_BIN)',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'ot-ccusage-real-'));
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('reports the pinned version', async () => {
      const source = new CcusageSource({ command: bin ?? '', homeDir: join(root, 'home') });
      expect(await source.check()).toEqual({ ok: true, version: CCUSAGE_PINNED_VERSION });
    });

    it('reads a fixture log written by the test, and only that', async () => {
      const profile = join(root, 'claude-profile');
      const project = join(profile, 'projects', 'fixture-project');
      mkdirSync(project, { recursive: true });
      const line = JSON.stringify({
        timestamp: '2026-11-17T12:00:00.000Z',
        sessionId: 'fixture-session',
        requestId: 'req_fixture_1',
        costUSD: 0.01,
        message: {
          id: 'msg_fixture_1',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        type: 'assistant',
      });
      writeFileSync(join(project, 'fixture-session.jsonl'), `${line}\n`);
      const source = new CcusageSource({ command: bin ?? '', homeDir: join(root, 'home') });
      const entries = await source.read({
        clientId: 'claude-code',
        profileDir: profile,
        sinceDay: '2026-11-01',
        untilDay: '2026-11-30',
      });
      expect(entries.length).toBeGreaterThan(0);
      const input = entries.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0);
      const output = entries.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0);
      expect(input).toBe(100);
      expect(output).toBe(50);
    });

    it('reads nothing from an empty profile', async () => {
      const profile = join(root, 'empty-profile');
      mkdirSync(profile, { recursive: true });
      const source = new CcusageSource({ command: bin ?? '', homeDir: join(root, 'home') });
      expect(await source.read({ clientId: 'claude-code', profileDir: profile })).toEqual([]);
    });
  },
);
