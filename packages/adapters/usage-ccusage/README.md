# @otheater/adapter-usage-ccusage

`CcusageSource`, the `UsageSource` of `@otheater/core` over the
[`ccusage`](https://github.com/ryoppippi/ccusage) CLI (architecture 5.6, decision N118). It is an
**audit** of the consumption the daemon counts from the signals (`UsageService`, P10), never the
source of the daemon's own numbers. `ccusage` is a level C tool (6.0): an external program, a
separate process, installed by the user. It is not a dependency of any `package.json` and nothing of
it is linked, imported or bundled.

Facts are marked **[V]** verified here, **[S]** secondary source and **[N]** unconfirmed. Keys are
**[proposta]** (the owner decides).

## What it does

- Runs `<command> --version` and requires the pinned version, `20.0.48` (`CCUSAGE_PINNED_VERSION`).
  Another version is `wrong_version`: the adapter reports it and the daemon audits nothing [V, with
  a fake `ccusage`].
- Reads with `<command> <client> daily --json --timezone UTC [--offline] [--since D] [--until D]`,
  `client` being `claude`, `codex` or `opencode`. The JSON is parsed for consumption fields only: day,
  model, input, output, cache read, cache write and cost [V, with a fake `ccusage`]. The real v20
  output shape of `claude daily` is **[V]** (run on 2026-11-18 against a fixture); the day rows of
  `codex` and `opencode` with data are **[N]**, so the parser accepts a few spellings and rejects
  anything else with an `AdapterUnavailable` that never echoes the output.
- A Claude profile with no `projects/` folder (it never ran a session) reads as no data: v20 exits 1
  for it [V], so the adapter does not run the tool there.
- One process per read, no shell (`execFile`), stdin closed, a timeout (`timeoutMs`).
- Nothing that is text of a conversation is kept, passed on or logged. An error carries only the exit
  code, a timeout or "not found".

## Safety of the data

By default `ccusage` reads the real logs of the user (`~/.claude`, `~/.codex`, OpenCode), and those
hold conversations. So the adapter:

- never inherits the environment: only `PATH` and temporary-directory variables come through;
- ALWAYS sets `HOME`, `USERPROFILE`, `XDG_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
  `OPENCODE_DATA_DIR` to a directory of its own (`homeDir`, which must be absolute), and the one
  directory of the profile for the client being read goes in the variable of that client;
- runs with `cwd` in that directory;
- runs only the command it was given: absolute path (`commandMode: 'explicit'`, the default) or a bare
  name looked up on `PATH` (`commandMode: 'path'`, an explicit choice, never an accident).

The tests write their fixtures and set `HOME` to a temporary directory. The integration test
(`ccusage.real.test.ts`) runs the real binary only when `OT_CCUSAGE_BIN` names it; otherwise it is
skipped. It ran on 2026-11-18 against `ccusage@20.0.48` and `@ccusage/ccusage-linux-x64@20.0.48`
and passed **[V]**.

## The native binary

`ccusage` 20.0.48 is a small Node launcher (MIT, no `dependencies`) that starts a native binary from
an optional package of its own (`@ccusage/ccusage-<platform>`) [V, `npm view`, 2026-11-18]. The
owner approved `@ccusage/ccusage-linux-x64@20.0.48` (MIT, no dependencies) on 2026-11-18; the user
installs `ccusage` with the platform package of their system, and the OTheater never bundles it.

## Configuration

The keys live in the daemon (`usage.ccusage.*`, [proposta]); the adapter takes the values as options:
`command`, `commandMode`, `homeDir`, `requiredVersion`, `timeoutMs`, `pricing` (`offline` adds
`--offline`, `online` does not) and `env` (the parent environment, read for `PATH` and the temporary-directory variables only; default `process.env`).
