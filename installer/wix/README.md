# The Windows installer (.msi)

Phase 10, P4. A per-user `.msi` (no administrator) built with the WiX Toolset **5.0.2**.

| File | What it is |
| --- | --- |
| `Product.wxs` | The package: files in `%LOCALAPPDATA%\Programs\OTheater`, the PATH of the user, and the two custom actions (`ot service install` at the end of the installation, `ot service uninstall` before the files go). |
| `build.ps1` | Runs `wix build` with the pinned version. Reads the version from `tools/release/release.config.json` (`versionOverride`) or `packages/daemon/package.json`. The notices are parameters (`-NoticesFile`, `-LauncherNoticesFile`). `-PrintVersionOnly` prints the derived versions without WiX. |
| `test-install.ps1` | Installs the package for the current user, checks, uninstalls, checks again. For a disposable Windows only (it needs `CI=true` or `-Force`). |

What goes into the package: `ot.exe` (the single executable of P1, installed under this name), `ot-job-launcher.exe` (P2, next to it, where the adapter looks first), `LICENSE` and the third-party notices.
The data folder (`%LOCALAPPDATA%\OTheater`) is not part of the package: install, upgrade and uninstall never touch it.

Build on a Windows machine, after `pnpm build`, the SEA (`node tools/release/dist/cli.js build --target win32-x64 --out dist/sea`) and `cargo build --release --locked` in `native/job-launcher`:

```powershell
.\installer\wix\build.ps1 -InstallWix   # installs `wix` 5.0.2 as a .NET global tool when it is missing
```

## License of WiX and the maintenance fee

WiX is a build tool here (level D) and is not part of the package. The pinned version is 5.0.2, under the MS-RL, with no EULA to accept and no fee (nuspec read on 2026-11-22). The owner chose series 5 on 2026-11-22 because series 6 and later come under the Open Source Maintenance Fee EULA. Neither the script nor the workflow accepts anything. The details are in the header of `build.ps1`.

## Not covered by the CI

The runner is an administrator with a disposable profile. Left to a manual try on a real Windows (docs/21, P4 and P12): the SmartScreen warning (the package is unsigned, N247), a standard user installing without elevation, and the daemon coming up after a real logon.
