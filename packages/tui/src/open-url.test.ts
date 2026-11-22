// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { hyperlink, openCommand, openUrl, webUrl, type OpenCommand } from './open-url.js';

// A fake address: no test opens a browser, the spawn is always the fake below.
const URL_OK = 'https://auth.example.test/oauth/authorize?client_id=x&state=a%20b&scope=p^q';

function ports(platform: NodeJS.Platform, env: Record<string, string> = {}, works = true) {
  const commands: OpenCommand[] = [];
  return {
    commands,
    ports: {
      environment: { platform, env },
      run: (command: OpenCommand): Promise<boolean> => {
        commands.push(command);
        return Promise.resolve(works);
      },
    },
  };
}

describe('webUrl', () => {
  it('accepts http and https addresses as they are', () => {
    expect(webUrl(URL_OK)).toBe(URL_OK);
    expect(webUrl('http://localhost:8080/cb?code=1')).toBe('http://localhost:8080/cb?code=1');
  });

  it('refuses other schemes, no host, spaces, control characters and quotes', () => {
    for (const bad of [
      '',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.test/x',
      'vscode://open?x=1',
      'https://',
      'not an address',
      'https://example.test/a b',
      'https://example.test/\x1b]52;c;AAAA\x07',
      'https://example.test/\n',
      'https://example.test/"x',
    ]) {
      expect(webUrl(bad), bad).toBeUndefined();
    }
  });
});

describe('openCommand', () => {
  it('picks the command of the system, with the address as a single argument', () => {
    expect(openCommand(URL_OK, 'linux')).toEqual({ command: 'xdg-open', args: [URL_OK] });
    expect(openCommand(URL_OK, 'freebsd')).toEqual({ command: 'xdg-open', args: [URL_OK] });
    expect(openCommand(URL_OK, 'darwin')).toEqual({ command: 'open', args: [URL_OK] });
    expect(openCommand(URL_OK, 'win32')).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', URL_OK],
    });
  });
});

describe('openUrl', () => {
  it('runs the command of the platform and says which one', async () => {
    const { commands, ports: p } = ports('linux');
    expect(await openUrl(URL_OK, p)).toEqual({ ok: true, command: 'xdg-open' });
    expect(commands).toEqual([{ command: 'xdg-open', args: [URL_OK] }]);
  });

  it('does not run anything over SSH', async () => {
    for (const name of ['SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT']) {
      const { commands, ports: p } = ports('linux', { [name]: 'x' });
      expect(await openUrl(URL_OK, p)).toEqual({ ok: false, reason: 'remote' });
      expect(commands).toEqual([]);
    }
  });

  it('does not run anything for an address that is not http or https', async () => {
    const { commands, ports: p } = ports('linux');
    expect(await openUrl('file:///etc/passwd', p)).toEqual({ ok: false, reason: 'bad_url' });
    expect(commands).toEqual([]);
  });

  it('reports a failure of the command, also when it throws', async () => {
    const failed = ports('darwin', {}, false);
    expect(await openUrl(URL_OK, failed.ports)).toEqual({
      ok: false,
      reason: 'failed',
      command: 'open',
    });
    const thrown = await openUrl(URL_OK, {
      environment: { platform: 'linux', env: {} },
      run: () => Promise.reject(new Error('boom')),
    });
    expect(thrown).toEqual({ ok: false, reason: 'failed', command: 'xdg-open' });
  });
});

describe('hyperlink', () => {
  it('wraps the text in OSC 8 with the id, closed after the text', () => {
    expect(hyperlink('text', URL_OK, 'id1')).toBe(
      `\x1b]8;id=id1;${URL_OK}\x1b\\text\x1b]8;;\x1b\\`,
    );
  });

  it('gives the text alone when the address is not one to open', () => {
    expect(hyperlink('text', 'file:///x', 'id1')).toBe('text');
    expect(hyperlink('text', 'https://a.test/\x1b', 'id1')).toBe('text');
  });
});
