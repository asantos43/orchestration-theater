// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchdServiceManager, launchAgentPath, renderLaunchdPlist } from './launchd.js';
import { createServiceManager } from './index.js';
import { daemonCommandOf, resolveServiceCommand, serviceIdOf } from './self-command.js';
import { FakeCommandRunner } from './service-fixture.js';
import { POSIX_SPEC, WINDOWS_SPEC } from './service-specs-fixture.js';
import {
  SystemdServiceManager,
  renderSystemdUnit,
  systemdConfigHome,
  systemdQuote,
  systemdUnitPath,
} from './systemd.js';
import { ServiceError } from './types.js';
import {
  WindowsTaskServiceManager,
  encodeTaskXml,
  quoteWindowsArg,
  renderTaskXml,
  taskAction,
} from './windows-task.js';

const reference = (name: string): Promise<string> =>
  readFile(new URL(`./reference/${name}`, import.meta.url), 'utf8');

/** A temp HOME for every test: nothing here may write to the real one. */
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'otheater-service-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('the definitions, as pure functions, against the reference files', () => {
  it('the systemd unit', async () => {
    expect(renderSystemdUnit(POSIX_SPEC)).toBe(await reference('otheater-daemon.service'));
  });

  it('the launchd plist', async () => {
    expect(renderLaunchdPlist({ ...POSIX_SPEC, id: 'com.otheater.daemon' })).toBe(
      await reference('com.otheater.daemon.plist'),
    );
  });

  it('the Task Scheduler XML', async () => {
    expect(renderTaskXml(WINDOWS_SPEC)).toBe(await reference('otheater-daemon.task.xml'));
  });

  it('restart and autostart change the unit (on_failure, always, never; manual has no trigger)', () => {
    expect(renderSystemdUnit({ ...POSIX_SPEC, restart: 'always' })).toContain('Restart=always');
    expect(renderSystemdUnit({ ...POSIX_SPEC, restart: 'never' })).toContain('Restart=no');
    const plistAlways = renderLaunchdPlist({ ...POSIX_SPEC, restart: 'always' });
    expect(plistAlways).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(renderLaunchdPlist({ ...POSIX_SPEC, restart: 'never' })).not.toContain('KeepAlive');
    const manual = renderLaunchdPlist({ ...POSIX_SPEC, autostart: 'manual' });
    expect(manual).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(manual).not.toContain('KeepAlive');
    expect(renderTaskXml({ ...WINDOWS_SPEC, autostart: 'manual' })).toMatch(
      /<LogonTrigger>\s*<Enabled>false<\/Enabled>/,
    );
    expect(renderTaskXml({ ...WINDOWS_SPEC, restart: 'never' })).not.toContain('RestartOnFailure');
  });

  it('the task shows a window only with service.console: visible', () => {
    expect(renderTaskXml(WINDOWS_SPEC)).toContain('<Command>conhost.exe</Command>');
    const visible = renderTaskXml({ ...WINDOWS_SPEC, console: 'visible' });
    expect(visible).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>');
    expect(visible).not.toContain('conhost');
  });

  it('escapes what XML and the command lines treat as special', () => {
    const spec = { ...POSIX_SPEC, dataDir: '/d/a&b<c>', path: '/p"q' };
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain('/d/a&amp;b&lt;c&gt;/logs/service.log');
    expect(plist).toContain('/p&quot;q');
    expect(systemdQuote('a b')).toBe('"a b"');
    expect(systemdQuote('50%')).toBe('"50%%"');
    expect(systemdQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg('plain')).toBe('plain');
    expect(quoteWindowsArg('a b')).toBe('"a b"');
    expect(quoteWindowsArg('')).toBe('""');
    expect(quoteWindowsArg('a\\b c\\')).toBe('"a\\b c\\\\"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(taskAction({ command: 'x.exe', args: ['a b'] }, 'visible')).toEqual({
      command: 'x.exe',
      args: '"a b"',
    });
  });

  it('the Windows XML is written as UTF-16 little endian with a byte order mark', () => {
    const bytes = encodeTaskXml('<a/>');
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe('<a/>');
  });
});

describe('the command the service runs (the single point P1 replaces)', () => {
  it('is the checkout: Node and the entry of ot, then daemon with an explicit data folder', () => {
    const self = resolveServiceCommand({ node: '/n/node', entry: '/ot/dist/cli.js' });
    expect(self).toEqual({ command: '/n/node', args: ['/ot/dist/cli.js'] });
    expect(daemonCommandOf(self ?? { command: '', args: [] }, '/d')).toEqual({
      command: '/n/node',
      args: ['/ot/dist/cli.js', 'daemon', '--data-dir', '/d'],
    });
    expect(resolveServiceCommand(undefined)).toBeUndefined();
  });

  it('has the ids of the plan: reverse DNS on macOS, a plain name elsewhere', () => {
    expect(serviceIdOf('darwin')).toBe('com.otheater.daemon');
    expect(serviceIdOf('linux')).toBe('otheater-daemon');
    expect(serviceIdOf('win32')).toBe('otheater-daemon');
  });

  it('picks the adapter by platform', () => {
    const base = { env: {}, homedir: home, run: new FakeCommandRunner().run, tmpDir: home };
    expect(createServiceManager({ ...base, platform: 'linux' })?.kind).toBe('systemd');
    expect(createServiceManager({ ...base, platform: 'darwin', uid: 501 })?.kind).toBe('launchd');
    expect(createServiceManager({ ...base, platform: 'win32' })?.kind).toBe('task');
    expect(createServiceManager({ ...base, platform: 'freebsd' })).toBeUndefined();
  });
});

describe('systemd --user: the calls it makes, in order, with a fake runner and a temp HOME', () => {
  const make = (run: FakeCommandRunner): SystemdServiceManager =>
    new SystemdServiceManager({
      id: 'otheater-daemon',
      configHome: systemdConfigHome({}, home),
      run: run.run,
    });

  it('install writes the unit under ~/.config/systemd/user, reloads, then enables', async () => {
    const run = new FakeCommandRunner();
    const result = await make(run).install(POSIX_SPEC);
    const file = systemdUnitPath(join(home, '.config'), 'otheater-daemon');
    expect(result.location).toBe(file);
    expect(await readFile(file, 'utf8')).toBe(await reference('otheater-daemon.service'));
    expect(run.lines).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable otheater-daemon.service',
    ]);
  });

  it('install with autostart: manual disables the trigger instead', async () => {
    const run = new FakeCommandRunner();
    await make(run).install({ ...POSIX_SPEC, autostart: 'manual' });
    expect(run.lines.at(-1)).toBe('systemctl --user disable otheater-daemon.service');
  });

  it('install fails with unavailable when there is no user bus, and with command_failed otherwise', async () => {
    const noBus = new FakeCommandRunner().on('daemon-reload', {
      code: 1,
      stderr: 'Failed to connect to bus: No medium found',
    });
    await expect(make(noBus).install(POSIX_SPEC)).rejects.toMatchObject({ code: 'unavailable' });
    const broken = new FakeCommandRunner().on('enable', { code: 1, stderr: 'boom' });
    await expect(make(broken).install(POSIX_SPEC)).rejects.toMatchObject({
      code: 'command_failed',
      detail: 'boom',
    });
  });

  it('uninstall stops, disables, removes the file, then reloads; the second one is a no-op', async () => {
    const run = new FakeCommandRunner();
    const manager = make(run);
    await manager.install(POSIX_SPEC);
    run.calls.length = 0;
    await manager.uninstall();
    expect(run.lines).toEqual([
      'systemctl --user stop otheater-daemon.service',
      'systemctl --user disable otheater-daemon.service',
      'systemctl --user daemon-reload',
    ]);
    await expect(stat(systemdUnitPath(join(home, '.config'), 'otheater-daemon'))).rejects.toThrow();
    run.calls.length = 0;
    await manager.uninstall();
    expect(run.lines).toEqual([]);
  });

  it('status reads is-enabled and is-active; no bus is a note, not an error', async () => {
    const run = new FakeCommandRunner()
      .on('is-enabled', { stdout: 'enabled\n' })
      .on('is-active', { stdout: 'active\n' });
    const manager = make(run);
    expect(await manager.status()).toMatchObject({ installed: false });
    await manager.install(POSIX_SPEC);
    expect(await manager.status()).toMatchObject({ installed: true, enabled: true, active: true });
    const noBus = new FakeCommandRunner().on('is-', {
      code: 1,
      stderr: 'Failed to connect to bus',
    });
    expect(await make(noBus).status()).toMatchObject({ installed: true, note: 'no_session' });
  });

  it('start and stop need the unit', async () => {
    const run = new FakeCommandRunner();
    const manager = make(run);
    await expect(manager.start()).rejects.toMatchObject({ code: 'not_installed' });
    await expect(manager.stop()).rejects.toBeInstanceOf(ServiceError);
    await manager.install(POSIX_SPEC);
    run.calls.length = 0;
    await manager.start();
    await manager.stop();
    expect(run.lines).toEqual([
      'systemctl --user start otheater-daemon.service',
      'systemctl --user stop otheater-daemon.service',
    ]);
  });

  it('XDG_CONFIG_HOME wins when it is absolute', () => {
    expect(systemdConfigHome({ XDG_CONFIG_HOME: '/x/cfg' }, home)).toBe('/x/cfg');
    expect(systemdConfigHome({ XDG_CONFIG_HOME: 'relative' }, home)).toBe(join(home, '.config'));
  });
});

describe('launchd: the calls it makes, in order, with a fake runner and a temp HOME', () => {
  const ID = 'com.otheater.daemon';
  const make = (run: FakeCommandRunner): LaunchdServiceManager =>
    new LaunchdServiceManager({ id: ID, home, uid: 501, run: run.run });
  const spec = (over: Partial<typeof POSIX_SPEC> = {}): typeof POSIX_SPEC => ({
    ...POSIX_SPEC,
    dataDir: join(home, 'data'),
    ...over,
  });

  it('install writes the plist in ~/Library/LaunchAgents, takes the old job out, then bootstraps', async () => {
    const run = new FakeCommandRunner();
    const result = await make(run).install(spec());
    expect(result.location).toBe(launchAgentPath(home, ID));
    expect(await readFile(result.location, 'utf8')).toContain(
      '<string>com.otheater.daemon</string>',
    );
    expect(run.lines).toEqual([
      'launchctl bootout gui/501/com.otheater.daemon',
      `launchctl bootstrap gui/501 ${result.location}`,
    ]);
  });

  it('install with manual autostart writes the plist and loads nothing; it says there is no restart rule', async () => {
    const run = new FakeCommandRunner();
    const result = await make(run).install(spec({ autostart: 'manual' }));
    expect(run.lines).toEqual(['launchctl bootout gui/501/com.otheater.daemon']);
    expect(result.notes).toEqual(['no_restart_when_manual']);
  });

  it('a bootstrap without a graphical session is unavailable', async () => {
    const run = new FakeCommandRunner().on('bootstrap', { code: -1, spawnFailed: true });
    await expect(make(run).install(spec())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('start loads the job when it is not loaded, then kickstarts; stop boots it out', async () => {
    const run = new FakeCommandRunner().on('print', { code: 113 });
    const manager = make(run);
    await expect(manager.start()).rejects.toMatchObject({ code: 'not_installed' });
    await manager.install(spec());
    run.calls.length = 0;
    await manager.start();
    expect(run.lines).toEqual([
      'launchctl print gui/501/com.otheater.daemon',
      `launchctl bootstrap gui/501 ${launchAgentPath(home, ID)}`,
      'launchctl kickstart gui/501/com.otheater.daemon',
    ]);
    const loaded = new FakeCommandRunner().on('print', { stdout: 'state = running\n' });
    const second = make(loaded);
    expect(await second.status()).toMatchObject({ installed: true, enabled: true, active: true });
    await second.stop();
    expect(loaded.lines.at(-1)).toBe('launchctl bootout gui/501/com.otheater.daemon');
  });

  it('uninstall boots the job out and removes the plist', async () => {
    const run = new FakeCommandRunner();
    const manager = make(run);
    await manager.install(spec());
    await manager.uninstall();
    await expect(stat(launchAgentPath(home, ID))).rejects.toThrow();
    expect(run.lines.at(-1)).toBe('launchctl bootout gui/501/com.otheater.daemon');
    expect(await manager.status()).toMatchObject({ installed: false });
  });
});

describe('the Windows task: the calls it makes, in order, with a fake runner', () => {
  const make = (run: FakeCommandRunner): WindowsTaskServiceManager =>
    new WindowsTaskServiceManager({ id: 'otheater-daemon', run: run.run, tmpDir: home });

  it('install creates the task from an XML file and removes the file', async () => {
    const run = new FakeCommandRunner();
    const seen: Buffer[] = [];
    const spying: FakeCommandRunner['run'] = async (command, args) => {
      const xml = args[args.indexOf('/XML') + 1];
      if (xml !== undefined) seen.push(await readFile(xml));
      return await run.run(command, args);
    };
    const manager = new WindowsTaskServiceManager({
      id: 'otheater-daemon',
      run: spying,
      tmpDir: join(home, 'tmp'),
    });
    const result = await manager.install({ ...WINDOWS_SPEC, restart: 'always' });
    expect(result).toEqual({
      location: 'otheater-daemon',
      notes: ['restart_always_is_on_failure'],
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.command).toBe('schtasks.exe');
    expect(run.calls[0]?.args.slice(0, 4)).toEqual(['/Create', '/TN', 'otheater-daemon', '/XML']);
    expect(run.calls[0]?.args.at(-1)).toBe('/F');
    expect([...(seen[0] ?? Buffer.alloc(0)).subarray(0, 2)]).toEqual([0xff, 0xfe]);
    await expect(stat(run.calls[0]?.args[4] ?? '')).rejects.toThrow();
  });

  it('uninstall ends and deletes the task, and does nothing when there is none', async () => {
    const run = new FakeCommandRunner();
    await make(run).uninstall();
    expect(run.lines).toEqual([
      'schtasks.exe /Query /TN otheater-daemon',
      'schtasks.exe /End /TN otheater-daemon',
      'schtasks.exe /Delete /TN otheater-daemon /F',
    ]);
    const none = new FakeCommandRunner().on('/Query', { code: 1 });
    await make(none).uninstall();
    expect(none.lines).toEqual(['schtasks.exe /Query /TN otheater-daemon']);
  });

  it('status says installed or not, and leaves the state to the discovery file', async () => {
    expect(await make(new FakeCommandRunner()).status()).toEqual({
      installed: true,
      location: 'otheater-daemon',
    });
    const none = new FakeCommandRunner().on('/Query', { code: 1 });
    expect(await make(none).status()).toMatchObject({ installed: false });
  });

  it('start runs the task, stop ends it; both need the task', async () => {
    const none = new FakeCommandRunner().on('/Query', { code: 1 });
    await expect(make(none).start()).rejects.toMatchObject({ code: 'not_installed' });
    const run = new FakeCommandRunner();
    const manager = make(run);
    await manager.start();
    await manager.stop();
    expect(run.lines.filter((line) => !line.includes('/Query'))).toEqual([
      'schtasks.exe /Run /TN otheater-daemon',
      'schtasks.exe /End /TN otheater-daemon',
    ]);
  });

  it('schtasks that cannot start is unavailable', async () => {
    const run = new FakeCommandRunner().on('/Create', { code: -1, spawnFailed: true });
    await expect(make(run).install(WINDOWS_SPEC)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
