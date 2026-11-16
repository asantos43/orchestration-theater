# ot-job-launcher

A minimal Rust program that the OTheater daemon uses on **Windows** to start each Executor
(Claude Code, Codex, OpenCode) inside a [Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
The job closes over the Executor and everything it starts, so when the launcher dies, Windows ends
the whole process tree. Architecture reference: section 5.9 of `docs/framework-ideas/arquitetura.md`;
the open question is N58 in `docs/13-DECISOES-EM-ABERTO.md`.

License: MPL-2.0. Not published to crates.io (`publish = false`).

## Usage

```text
ot-job-launcher [--memory-limit-bytes <n>] -- <exe> [args...]
```

- Everything after the first `--` belongs to the Executor and is never interpreted.
- `<exe>` should be an absolute path. A bare name is searched by `CreateProcessW` (launcher
  folder, current directory, system folders, `PATH`; `.exe` is appended when there is no
  extension).
- stdin, stdout, stderr and the environment are inherited from the launcher; so is the current
  directory.
- The launcher waits for the Executor and exits with the **same exit code** (32 bits on Windows).
- `.cmd` and `.bat` programs are refused: they run through `cmd.exe`, which expands `%VAR%` and
  re-parses the arguments (argument injection). Pass the real executable, for example `node.exe`
  plus the script path.

### What the job does

- `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: when the last handle to the job closes (the launcher
  exits, crashes or is terminated), every process still in the job is terminated. This includes
  descendants that outlive the Executor: they do not survive the launcher.
- No `JOB_OBJECT_LIMIT_BREAKAWAY_OK`: a descendant cannot leave the job.
- `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`: no crash dialog for processes in the job.
- `--memory-limit-bytes <n>` sets `JOB_OBJECT_LIMIT_JOB_MEMORY`: a ceiling on the **committed
  (virtual) memory of the whole job, all processes together**, not per process and not the working
  set (RSS). Past the ceiling, new commits fail, so the process that tries usually aborts or
  reports an allocation error.
- The Executor is created `CREATE_SUSPENDED`, assigned to the job and only then resumed, so it
  never runs outside the job.

### Exit codes

The Executor's code passes through unchanged. The launcher's own failures use a block that is not
a small program code and not an NTSTATUS value:

| Code | Meaning |
| --- | --- |
| `0x4F540001` | wrong command line (unknown option, missing `--`, no program, bad number, NUL or too long) |
| `0x4F540002` | the job could not be created or configured |
| `0x4F540003` | `CreateProcessW` failed (missing program, no permission) |
| `0x4F540004` | the process could not be assigned to the job (it is terminated, never resumed) |
| `0x4F540005` | the main thread could not be resumed (the process is terminated) |
| `0x4F540006` | waiting for the process, or reading its exit code, failed |
| `0x4F540007` | the program is a `.cmd` or `.bat` script (refused) |
| `78` | not Windows: the binary prints "this program only works on Windows" and exits |

A posix exit code has 8 bits, which is why the non-Windows code is small. The daemon can treat an
exit code in `0x4F540001..0x4F540007` as "the launcher failed" (an Executor could return it too,
but it is a very unlikely value).

### Command line and quoting

`CreateProcessW` takes one string. The launcher rebuilds it from the already split arguments with
the Microsoft C runtime rules (`src/cmdline.rs`, pure code tested on every platform). `$HOME`,
`${HOME}`, `$$`, `%h` and `%PATH%` reach the Executor as plain text: no shell is involved.

## Build and check

```text
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo check --locked --target x86_64-pc-windows-msvc --all-targets   # from Linux or macOS
```

The last line only compiles (it needs the target installed with `rustup target add
x86_64-pc-windows-msvc`); it does not link or run. On Linux and macOS `cargo test` runs the pure
unit tests (arguments, quoting, exit codes) and checks that the binary exits with 78.

The **real test runs on Windows CI** (N58): `tests/windows.rs` (job tree dies when the launcher is
terminated, exit code passes through, stdin/stdout cross, the memory limit stops whoever exceeds
it) uses `examples/helper.rs` and only runs there. In `.github/workflows/ci.yml` this is the
`windows-launcher` job, started by hand (`workflow_dispatch`).

## Maintenance

- Dependencies are exact (`=x.y.z`) and `Cargo.lock` is committed. `pnpm verify` classifies the
  licenses of the crates in every `native/*/Cargo.lock` with the same policy as the npm packages
  (`tools/verify/policy.json`; it needs `cargo` on `PATH`).
- When `Cargo.lock` changes, update `THIRD_PARTY_NOTICES.md` in this folder.
- Only `src/launch.rs` has `unsafe` code (one Win32 call per block, each with a SAFETY comment).

## Not done yet

- Graceful shutdown (a Ctrl+Break or a stop event before the kill) is not implemented. The
  daemon can already ask the Executor to stop through ACP (`session/cancel`, then close stdin,
  which the Executor owns directly) before ending the launcher.
- `.cmd` and `.bat` programs are refused, not run through `cmd.exe`.
