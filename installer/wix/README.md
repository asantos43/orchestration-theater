# The Windows installer (.msi)

Phase 10, P4. A per-user `.msi` (no administrator) built with the WiX Toolset **5.0.2**.

| File | What it is |
| --- | --- |
| `Product.wxs` | The package: files in `%LOCALAPPDATA%\Programs\OTheater`, the PATH of the user, the page of options (N322) and the custom actions (`ot vault use`, `ot adapters install` and `ot service install` at the end of the installation, `ot service uninstall` before the files go). |
| `build.ps1` | Runs `wix build` with the pinned version. Reads the version from `tools/release/release.config.json` (`versionOverride`) or `packages/daemon/package.json`. The notices are parameters (`-NoticesFile`, `-LauncherNoticesFile`). `-PrintVersionOnly` prints the derived versions without WiX. |
| `test-install.ps1` | Installs the package for the current user, checks, uninstalls, checks again. For a disposable Windows only (it needs `CI=true` or `-Force`). |

## The choices of the install (N322)

A double click shows one page: where to keep the secrets (keep what is configured, the Windows Credential Manager, an encrypted file, or auto), a check box for the logon service and one for downloading the ACP adapters now, and the Install button. No wizard, no folder choice, no EULA. A choice that needs an administrator would carry the UAC shield and "needs administrator"; none does (the package is per user), and the page says so. The page is made of core WiX elements, with no WixUI extension. [proposta]

A silent install takes the same choices as properties: `VAULT` (`keep`, the default, `keyring`, `encrypted-file` or `auto`), `LOGON_SERVICE` (`1`, the default, or `0`) and `PREFETCH_ADAPTERS` (`1`, the default, or `0`). For example:

```powershell
msiexec /i OTheater-<version>-win32-x64.msi /qn VAULT=encrypted-file PREFETCH_ADAPTERS=0
```

Another value of `VAULT` stops the install before anything is done. A vault that cannot be written or a download that fails does not fail the install: `ot vault use` and `ot adapters install` do it later. The test of the package (`test-install.ps1`) installs with `VAULT=encrypted-file PREFETCH_ADAPTERS=0` and checks the vault.

What goes into the package: `ot.exe` (the single executable of P1, installed under this name), `ot-job-launcher.exe` (P2, next to it, where the adapter looks first), `LICENSE` and the third-party notices.
The data folder (`%LOCALAPPDATA%\OTheater`) is not part of the package: install, upgrade and uninstall never touch it.
What an update leaves in the install folder (the journal `update-state.json`, its `.tmp`, `update-apply.log`, `previous\ot.exe`, `staging\ot.exe` and the two proofs in `staging\`) is removed by the uninstall (`RemoveFile`, core WiX, one name each; component `OtUpdateLeftovers`), so the folder can go; a file of the user in it stays, and the folder with it (N303).

Build on a Windows machine, after `pnpm build`, the SEA (`node tools/release/dist/cli.js build --target win32-x64 --out dist/sea`) and `cargo build --release --locked` in `native/job-launcher`:

```powershell
.\installer\wix\build.ps1 -InstallWix   # installs `wix` 5.0.2 as a .NET global tool when it is missing
```

## License of WiX and the maintenance fee

WiX is a build tool here (level D) and is not part of the package. The pinned version is 5.0.2, under the MS-RL, with no EULA to accept and no fee (nuspec read on 2026-11-22). The owner chose series 5 on 2026-11-22 because series 6 and later come under the Open Source Maintenance Fee EULA. Neither the script nor the workflow accepts anything. The details are in the header of `build.ps1`.

## Not covered by the CI

The runner is an administrator with a disposable profile. Left to a manual try on a real Windows (docs/21, P4 and P12): the SmartScreen warning (the package is unsigned, N247), a standard user installing without elevation, and the daemon coming up after a real logon.
