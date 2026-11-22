// SPDX-License-Identifier: MPL-2.0
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { entryFiles, entrySource } from './entry.js';

describe('the entry of the bundle', () => {
  it('points at the compiled files of the three packages', () => {
    const files = entryFiles('/repo');
    expect(files.seaMain).toBe(path.join('/repo', 'packages', 'daemon', 'dist', 'sea', 'main.js'));
    expect(files.seaNative).toBe(
      path.join('/repo', 'packages', 'client', 'dist', 'node', 'sea.js'),
    );
    expect(files.tuiMain).toBe(path.join('/repo', 'packages', 'tui', 'dist', 'run-main.js'));
  });

  it('wires the native loader, starts yoga before the TUI and has no top-level await', () => {
    const source = entrySource({
      seaMain: '/a/main.js',
      seaNative: '/a/sea.js',
      tuiMain: '/a/tui.js',
    });
    expect(source).toContain('globalThis.__otSeaNative = { load: loadSeaNative }');
    expect(source.indexOf('__otYoga')).toBeLessThan(source.indexOf('await import("/a/tui.js")'));
    expect(source).toContain('runSeaMain(process.argv.slice(2)');
    // Every `await` is inside an async function: the line before the first is the handler.
    const first = source.indexOf('await ');
    expect(source.lastIndexOf('async', first)).toBeGreaterThan(source.indexOf('runSeaMain('));
  });

  it('quotes a path that has odd characters', () => {
    const source = entrySource({ seaMain: 'C:\\a b\\main.js', seaNative: 'x', tuiMain: 'y' });
    expect(source).toContain('"C:\\\\a b\\\\main.js"');
  });
});
