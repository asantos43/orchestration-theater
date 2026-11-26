// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadReleaseConfig } from './config.js';
import { repoRoot } from './resolve.js';

/**
 * Checks of the sources of the .msi (Phase 10, P4) that need no Windows and no WiX: the pieces that
 * must agree with each other (the WiX version, the variables, the sequence of the custom actions).
 * That the package installs and removes cleanly is what `.github/workflows/dist-msi.yml` proves.
 */
const root = repoRoot();
const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), 'utf8');

const buildScript = read('installer', 'wix', 'build.ps1');
const testScript = read('installer', 'wix', 'test-install.ps1');
const product = read('installer', 'wix', 'Product.wxs');
const workflow = read('.github', 'workflows', 'dist-msi.yml');

/** The text with the comments out: help blocks and `#` lines (PowerShell), `#` lines (YAML). */
function withoutComments(text: string): string {
  return text
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('the sources of the .msi', () => {
  it('pins the same WiX version in the script and in the workflow, in series 5 (MS-RL)', () => {
    const inScript = /\$WixVersion\s*=\s*'([^']+)'/.exec(buildScript)?.[1];
    const inWorkflow = /WIX_VERSION:\s*'([^']+)'/.exec(workflow)?.[1];
    expect(inScript).toMatch(/^5\.\d+\.\d+$/);
    expect(inWorkflow).toBe(inScript);
  });

  it('writes no acceptance of the WiX EULA (that is the owner’s decision)', () => {
    for (const text of [buildScript, testScript, workflow]) {
      expect(withoutComments(text)).not.toMatch(/eula|acceptEula/i);
    }
  });

  it('passes to WiX every variable the .wxs reads, and only the optional one is conditional', () => {
    const used = new Set([...product.matchAll(/\$\(([A-Za-z]+)\)/g)].map((m) => m[1]));
    const passed = new Set([...buildScript.matchAll(/'-d',\s*"([A-Za-z]+)=/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(
      ['JobLauncher', 'LauncherNotices', 'License', 'Notices', 'OtExe', 'SemVer', 'Version'].sort(),
    );
    expect([...passed].sort()).toEqual([...used].sort());
    expect(product).toMatch(/<\?ifdef LauncherNotices \?>/);
  });

  it('installs per user, with the files, the PATH and no administrator', () => {
    expect(product).toMatch(/Scope="perUser"/);
    expect(product).toMatch(/Id="LocalAppDataFolder"/);
    expect(product).toMatch(/Name="Programs"/);
    expect(product).toMatch(/Name="ot\.exe"/);
    expect(product).toMatch(/Name="ot-job-launcher\.exe"/);
    expect(product).toMatch(/<Environment [^>]*Name="PATH"[^>]*System="no"/);
    expect(product).not.toMatch(/ProgramFiles|Scope="perMachine"|ALLUSERS/);
  });

  it('gives a fixed GUID to the component with files and a registry key path (WIX0230)', () => {
    expect(product).toMatch(
      /<Component Id="OtBinaries" [^>]*Guid="[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}"/,
    );
  });

  it('runs `ot service install` after the files and `ot service uninstall` before they go, as the user', () => {
    const actions = [...product.matchAll(/<CustomAction[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(actions).toHaveLength(5);
    for (const action of actions) {
      expect(action).toMatch(/Execute="deferred"/);
      expect(action).toMatch(/Impersonate="yes"/);
      expect(action).toMatch(/Return="ignore"/);
    }
    expect(product).toMatch(/service install --no-start"/);
    expect(product).toMatch(/service uninstall"/);
    expect(product).toMatch(
      /Action="OtServiceInstall" After="OtAdaptersInstallCodex" Condition="NOT REMOVE AND LOGON_SERVICE AND LOGON_SERVICE&lt;&gt;&quot;0&quot;"/,
    );
    expect(product).toMatch(
      /Action="OtServiceUninstall" Before="RemoveFiles" Condition="REMOVE=&quot;ALL&quot;"/,
    );
  });

  it('asks the choices of the install on one page, and takes them as properties when silent (N322)', () => {
    for (const [name, value] of [
      ['VAULT', 'keep'],
      ['LOGON_SERVICE', '1'],
      ['PREFETCH_ADAPTERS', 'all'],
    ] as const) {
      expect(product).toContain(`<Property Id="${name}" Value="${value}" Secure="yes" />`);
    }
    // The vault and the adapters go after the files and before the service, in this order.
    expect(product).toMatch(/vault use \[VAULT\]"/);
    expect(product).toMatch(/adapters install claude-code"/);
    expect(product).toMatch(/adapters install codex"/);
    expect(product).toMatch(
      /Action="OtVaultUse" After="InstallFiles" Condition="NOT REMOVE AND VAULT AND VAULT&lt;&gt;&quot;keep&quot;"/,
    );
    // One action per adapter (N324): all and 1 run both, claude-code and codex one each.
    const runs = (client: string) =>
      `Condition="NOT REMOVE AND (PREFETCH_ADAPTERS=&quot;all&quot; OR PREFETCH_ADAPTERS=&quot;1&quot; OR PREFETCH_ADAPTERS=&quot;${client}&quot;)"`;
    expect(product).toContain(
      `Action="OtAdaptersInstallClaude" After="OtVaultUse" ${runs('claude-code')}`,
    );
    expect(product).toContain(
      `Action="OtAdaptersInstallCodex" After="OtAdaptersInstallClaude" ${runs('codex')}`,
    );
    // A value of VAULT or PREFETCH_ADAPTERS that is not known stops the install before anything is done.
    expect(product).toMatch(/<Launch\s+Condition="Installed OR VAULT=/);
    const prefetchLaunch = /<Launch\s+Condition="Installed OR NOT PREFETCH_ADAPTERS ([^"]*)"/.exec(
      product,
    );
    expect(prefetchLaunch).not.toBeNull();
    for (const value of ['all', 'claude-code', 'codex', '0', '1']) {
      expect(prefetchLaunch?.[1]).toContain(`PREFETCH_ADAPTERS=&quot;${value}&quot;`);
    }
    // The page: the four vaults, the two check boxes, the Install button with the shield, no EULA.
    for (const vault of ['keep', 'keyring', 'encrypted-file', 'auto']) {
      expect(product).toContain(`<RadioButton Value="${vault}"`);
    }
    expect(product).toMatch(/Type="CheckBox" Property="LOGON_SERVICE" CheckBoxValue="1"/);
    // One box per adapter (N324), checked from PREFETCH_ADAPTERS before the page and written back to
    // it by the Install button, one value for each of the four combinations, before EndDialog.
    expect(product).toMatch(/Type="CheckBox" Property="OtPrefetchClaude" CheckBoxValue="1"/);
    expect(product).toMatch(/Type="CheckBox" Property="OtPrefetchCodex" CheckBoxValue="1"/);
    expect(product).not.toMatch(/Type="CheckBox" Property="PREFETCH_ADAPTERS"/);
    for (const [id, client] of [
      ['OtPrefetchClaude', 'claude-code'],
      ['OtPrefetchCodex', 'codex'],
    ] as const) {
      expect(product).toMatch(
        new RegExp(
          `<SetProperty\\s+Id="${id}"\\s+Value="1"\\s+After="LaunchConditions"\\s+Sequence="ui"\\s+Condition="PREFETCH_ADAPTERS=&quot;all&quot; OR PREFETCH_ADAPTERS=&quot;1&quot; OR PREFETCH_ADAPTERS=&quot;${client}&quot;"`,
        ),
      );
    }
    const install = /<Control Id="Install"[\s\S]*?<\/Control>/.exec(product)?.[0] ?? '';
    for (const [value, condition] of [
      ['all', 'OtPrefetchClaude AND OtPrefetchCodex'],
      ['claude-code', 'OtPrefetchClaude AND NOT OtPrefetchCodex'],
      ['codex', 'NOT OtPrefetchClaude AND OtPrefetchCodex'],
      ['0', 'NOT OtPrefetchClaude AND NOT OtPrefetchCodex'],
    ] as const) {
      expect(install).toMatch(
        new RegExp(
          `<Publish Property="PREFETCH_ADAPTERS" Value="${value}" Order="[1-4]" Condition="${condition}" />`,
        ),
      );
    }
    expect(install).toMatch(/<Publish Event="EndDialog" Value="Return" Order="5" \/>/);
    expect(product).toMatch(/Id="Install" Type="PushButton"[^>]*ElevationShield="yes"/);
    expect(product).toContain('needs administrator');
    expect(product).toMatch(/<Show Dialog="OtOptionsDlg" [^>]*Condition="NOT Installed"/);
    expect(product).not.toMatch(/<UIRef|WixUI_|LicenseAgreement|WixUILicenseRtf/);
    // The test of the .msi passes them, and never downloads the adapters.
    expect(testScript).toContain("'VAULT=encrypted-file', 'PREFETCH_ADAPTERS=0'");
    // And it checks that an unknown value of PREFETCH_ADAPTERS is refused, with nothing installed.
    expect(testScript).toContain("'PREFETCH_ADAPTERS=gemini'");
    expect(testScript).toMatch(/\$code -eq 1603/);
  });

  it('never touches the data folder', () => {
    expect(product).not.toMatch(/RemoveFolderEx/);
    // The data folder is only named as the argument given to `ot`.
    const mentions = [...product.matchAll(/OTheater&quot;/g)];
    const asArgument = [
      ...product.matchAll(/--data-dir &quot;\[LocalAppDataFolder\]OTheater&quot;/g),
    ];
    expect(mentions).toHaveLength(5);
    expect(asArgument).toHaveLength(5);
  });

  it('removes what the updates leave, by exact name, in the install folder only (N303)', () => {
    const removals = [...product.matchAll(/<RemoveFile [^>]*>/g)].map((m) => m[0]);
    const entries = removals.map((tag) => ({
      directory: /Directory="([^"]+)"/.exec(tag)?.[1],
      name: /Name="([^"]+)"/.exec(tag)?.[1],
    }));
    // Folders: the install folder and the two the applier makes in it, nothing else.
    for (const entry of entries) {
      expect(['INSTALLFOLDER', 'OtPreviousDir', 'OtStagingDir']).toContain(entry.directory);
    }
    // The only pattern is the temporary journal of a killed writer: no `*.*`, no `*`.
    expect(entries.map((entry) => entry.name).filter((name) => /[*?]/.test(name ?? ''))).toEqual([
      'update-state.json.*.tmp',
    ]);
    // The same list as install.sh (remove_update_leftovers), which the layout of the applier gives.
    const script = read('installer', 'install.sh');
    for (const name of [
      'update-state.json',
      'update-apply.log',
      'manifest.json',
      'manifest.json.sig',
    ]) {
      expect(entries.map((entry) => entry.name)).toContain(name);
      expect(script).toContain(name);
    }
    expect(script).toContain('update-state.json.*.tmp');
    expect(
      entries.filter((entry) => entry.name === 'ot.exe').map((entry) => entry.directory),
    ).toEqual(['OtPreviousDir', 'OtStagingDir']);
    // No WiX extension: the elements above are core ones.
    expect(product).not.toMatch(/xmlns:(util|ui|fire|netfx)=/);
    // The component that holds them has its own fixed GUID (a registry key path, ICE38).
    expect(product).toMatch(
      /<Component Id="OtUpdateLeftovers" [^>]*Guid="[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}"/,
    );
  });

  it('checks, in the test of the .msi, that the leftovers of an update are gone with the folder', () => {
    expect(testScript).toMatch(/update-state\.json/);
    expect(testScript).toMatch(/the install folder is gone/);
  });

  it('derives the version from the config the way build.ps1 does (it is a semver that fits an MSI)', () => {
    const config = loadReleaseConfig(path.join(root, 'tools', 'release', 'release.config.json'));
    const manifest = JSON.parse(read('packages', 'daemon', 'package.json')) as { version: string };
    const semver = config.versionOverride ?? manifest.version;
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(semver);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(255);
    expect(Number(match?.[2])).toBeLessThanOrEqual(255);
    expect(Number(match?.[3])).toBeLessThanOrEqual(65535);
    // The pattern of build.ps1 is the one of config.ts.
    expect(buildScript).toContain(
      String.raw`'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$'`,
    );
  });
});
