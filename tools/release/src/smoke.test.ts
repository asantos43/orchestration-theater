// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { PTY_SCRIPT, runSmoke, SMOKE_CONFIG } from './smoke.js';

describe('the smoke of the executable', () => {
  it('fails, and says so, when the executable is not there', async () => {
    const lines: string[] = [];
    const result = await runSmoke({
      executable: '/no/such/otheater',
      log: (line) => lines.push(line),
    });
    expect(result.ok).toBe(false);
    expect(lines.join('\n')).toContain('executable not found');
  });

  it('runs the daemon on the file vault and with no scheduled backup', () => {
    expect(SMOKE_CONFIG).toContain('vault: encrypted-file');
    expect(SMOKE_CONFIG).toContain('when: manual');
  });

  it('the terminal harness starts the TUI mode with an empty PATH and presses Esc and Ctrl+Q', () => {
    expect(PTY_SCRIPT).toContain("'--ot-internal=tui'");
    expect(PTY_SCRIPT).toContain("os.environ['PATH'] = tui_path");
    expect(PTY_SCRIPT).toContain("b'\\x11'");
  });
});
