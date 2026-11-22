// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  parseConfig,
  SERVICE_AUTOSTART_MODES,
  SERVICE_CONSOLE_MODES,
  SERVICE_RESTART_MODES,
  TUI_START_DAEMON_MODES,
} from './config.js';

/** The `service` and `tui` sections of the configuration (Phase 10, P3). */
describe('config: service and tui', () => {
  it('has the conservative defaults', () => {
    const config = parseConfig('');
    expect(config.service).toEqual({
      restart: 'on_failure',
      autostart: 'logon',
      console: 'hidden',
    });
    expect(config.tui).toEqual({ start_daemon: 'service', start_timeout: 15_000 });
  });

  it('accepts every mode of every key', () => {
    for (const restart of SERVICE_RESTART_MODES) {
      expect(parseConfig(`service:\n  restart: ${restart}\n`).service.restart).toBe(restart);
    }
    for (const autostart of SERVICE_AUTOSTART_MODES) {
      expect(parseConfig(`service:\n  autostart: ${autostart}\n`).service.autostart).toBe(
        autostart,
      );
    }
    for (const mode of SERVICE_CONSOLE_MODES) {
      expect(parseConfig(`service:\n  console: ${mode}\n`).service.console).toBe(mode);
    }
    for (const mode of TUI_START_DAEMON_MODES) {
      expect(parseConfig(`tui:\n  start_daemon: ${mode}\n`).tui.start_daemon).toBe(mode);
    }
    expect(parseConfig('tui:\n  start_timeout: 30s\n').tui.start_timeout).toBe(30_000);
  });

  it('rejects a mode it does not know and a key it does not know', () => {
    expect(() => parseConfig('service:\n  restart: sometimes\n')).toThrow();
    expect(() => parseConfig('service:\n  extra: 1\n')).toThrow();
    expect(() => parseConfig('tui:\n  start_daemon: maybe\n')).toThrow();
    expect(() => parseConfig('tui:\n  start_timeout: soon\n')).toThrow();
  });
});
