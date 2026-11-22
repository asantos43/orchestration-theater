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
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action).toMatch(/Execute="deferred"/);
      expect(action).toMatch(/Impersonate="yes"/);
      expect(action).toMatch(/Return="ignore"/);
    }
    expect(product).toMatch(/service install --no-start"/);
    expect(product).toMatch(/service uninstall"/);
    expect(product).toMatch(
      /Action="OtServiceInstall" After="InstallFiles" Condition="NOT REMOVE"/,
    );
    expect(product).toMatch(
      /Action="OtServiceUninstall" Before="RemoveFiles" Condition="REMOVE=&quot;ALL&quot;"/,
    );
  });

  it('never touches the data folder', () => {
    expect(product).not.toMatch(/RemoveFile\b|RemoveFolderEx/);
    // The data folder is only named as the argument given to `ot`.
    const mentions = [...product.matchAll(/OTheater&quot;/g)];
    expect(mentions).toHaveLength(2);
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
