# @otheater/adapter-client-opencode

The `ClientAdapter` of OpenCode (`class OpenCodeAdapter`) and its `ModelCatalog`
(`OpenCodeModelCatalog`). It is the Phase 2 step P7c. The executable is a tool the user installs
(decision N45): `opencode` is never a dependency of this package, and the tests below do not start it
unless the environment says so.

Every statement about the client carries its source: **[V]** verified on this machine in Phase 0
(`opencode` 1.19.5), **[S]** secondary (docs or source code of the client, not run), **[N]** not
confirmed. Everything marked **[proposta]** is a default or a key the owner has not decided.

## What it translates

| Port member             | OpenCode                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `command()`             | `opencode acp` (key `clients.opencode.command`) [V]                                                                                      |
| `processModel`          | `pool.opencode.process_model`: `per_profile` is `multi-session` (default), `per_session` is `process-per-session` (N56)                  |
| `profileEnv`            | `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `OPENCODE_DB` (inside the profile), the pinned `OPENCODE_PERMISSION`, `OPENCODE_DISABLE_PROJECT_CONFIG=1` [V] |
| `prepareProfile`        | creates the profile folders and an `opencode.json` of the profile; keeps the permission of the launch (see below)                        |
| `sessionSetup`          | ACP: no `--auto` anywhere; `mode: plan` only with `read_only_mode: plan`. Headless: `run --format json` [N]                              |
| `enforcement`           | layer `client` for tools, shell, write scope and (isolated config) MCP servers; `onAsk` and `bypass` also `daemon`; `network` none        |
| `mapConfig`             | `model`, `effort`, `mode`: the ACP config option ids of 1.19.5 [V]                                                                       |
| `normalizeUpdate/Error` | the updates and errors measured in Phase 0 [V]; the stream of `run --format json` is not translated [N]                                 |
| `models`                | `assisted`: `opencode models --verbose` in the profile directory, through the injected `ProcessLauncher`                                 |
| `quota`                 | rejects with `AdapterUnavailable` ("arrives in Phase 5")                                                                                  |
| `login` / `logout`      | reject with `AdapterUnavailable` ("arrives in Phase 5")                                                                                   |
| `probes`                | the permission probe of the package (below)                                                                                              |

### The permission (the core of the adapter)

`OPENCODE_PERMISSION` has the highest precedence of the three sources (`opencode.json` <
`OPENCODE_CONFIG_CONTENT` < `OPENCODE_PERMISSION`) [V], and `OPENCODE_DISABLE_PROJECT_CONFIG`
exists [V]. The neutral policy becomes one action per tool key, with `"*"` first because the last
matching rule wins [V]:

- tools of the role: `allow`; tools the role does not have: `deny` (the shell key `bash` is verified
  as "Invalid Tool" [V]; the other keys come from the permission docs [S] and are [N] here);
- `nativeShell: none`: `bash` is `deny`. The V2 docs call it `shell` [S]; for 1.19.5 only `bash` was
  verified, so `shell` is not in the default. Key `clients.opencode.shell_keys` [proposta];
- everything else is `ask`, and the base answers `session/request_permission` with `reject_once`
  (layer 2); there is no bypass through ACP [V];
- `external_directory`: `deny` (`writeScope: worktree`); `task`, `webfetch`, `websearch` and `skill`
  are `deny` [S].

`profileEnv(profile)` receives no policy, but `prepareProfile(profile, policy)` does. So the adapter
keeps the permission of a launch in a slot per profile directory: `prepareProfile` takes a turn
(a second `openSession` on the same profile waits), stores the permission, and `profileEnv` takes it.
A call that skipped `prepareProfile` gets a deny-everything permission (fail closed), and a slot nobody
takes is dropped after `slotTimeoutMs` (default 30 s [proposta]).

### Own probe

`createPermissionProbe` writes an `opencode.json` with `allow` for everything into a scratch worktree,
opens a session through the adapter under test with the read-only role, asks for a file edit and a
shell command, and passes only if neither file exists. A turn that does not end, a session that does
not open and a cleanup that fails are failures. It sends a real prompt, so the daemon runs it once per
client version. The probe needs a transport and a scratch directory, which the `ProbeContext` does not
carry, so they are the constructor option `permissionProbe`; without it the probe reports "not run" and
fails (fail closed).

### Model catalog

`opencode models --verbose` prints, per model, a line `providerID/modelID` and the model as indented
JSON. The shape of the output is **[S]** (the source of the command); the content of the JSON was
measured in Phase 0 [V] (532 models, `family` empty in 42). No fixture comes from a real client: the
tests use a hand-made one. `parseModelsVerbose` keeps what it can read and counts the rest as
`skipped`, never guessing a field.

- `list`: efforts are the `variants` keys; `local` is a loopback `api.url`; window, tool calls and
  cost come from the registry of the client. Cached for `cacheMs` (default 60 s [proposta]).
- `suggest`: effort (first of `effort_preference` the model offers, default `medium, low, high`
  [proposta]), family, local, window and cost; it fills only what the catalog knows.
- `validate`: profile, model, effort (`default` is always accepted [V]), tool calls and minimum
  context window; the severity of the window follows `roles.capability_check` (`contextSeverity`).

## Options and keys

All defaults are options that become configuration keys with more than one mode. [proposta] for the
names.

| Option                          | Key (proposta)                       | Modes / default                                                           |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `command`                       | `clients.opencode.command`           | any `cmd` and `args`; default `opencode acp`                              |
| `processModel`                  | `pool.opencode.process_model`        | `per_profile` (default), `per_session`                                    |
| `isolation`                     | `clients.opencode.isolation`         | any of `data`, `config`, `state`, `cache`; default `data`, `config`       |
| `profileConfig`                 | `clients.opencode.profile_config`    | an object, or `null` for no file; default `autoupdate: false`, `share: disabled` [S] |
| `shellKeys`                     | `clients.opencode.shell_keys`        | default `['bash']`; `['bash', 'shell']` for V2                            |
| `projectConfig`                 | `clients.opencode.project_config`    | `disabled` (default), `enabled`                                           |
| `readOnlyMode`                  | `clients.opencode.read_only_mode`    | `none` (default), `plan`                                                  |
| `catalog.effortPreference`      | `clients.opencode.suggest.effort_preference` | list; default `medium, low, high`                                |
| `catalog.minContextWindow`      | from `roles.capability_check`        | number; severity `warning` or `error`                                     |
| `slotTimeoutMs`                 | (internal)                           | default 30 s                                                              |

`readOnlyMode` is `none` by default because whether the rules of `plan` mode win over the pinned
permission was not measured [N]; the pinned permission is the measured mechanism.

## Tests

- `*.test.ts`: unit tests with hand-made fixtures, and the conformance suites of `@otheater/sdk`
  over the adapter (a) in memory with `FakeSessionTransport`, and (b) end to end with the
  `@otheater/fake-agent` as a child process over ACP (`pnpm build` first). Both use `per_session`.
- `opencode.real.test.ts`: against the real `opencode`, never in a plain run (N57).
  `OT_TEST_REAL_CLIENTS=1` starts the client (conformance without prompts, catalog);
  `OT_TEST_REAL_PROMPTS=1` also sends prompts and spends quota (conformance with prompts, own probe).
  `OT_TEST_OPENCODE_PROFILE_DIR` points at an already logged-in profile (used as is, never deleted);
  without it the profile is empty and not logged in. The test never reads or prints credentials.

## Gaps and divergences

- **`multi-session` cannot open sessions yet.** The base rejects that model until the pool (P8)
  exists, so the default `per_profile` is only declared. A pooled process has one environment, so the
  pool key must include the hash of `OPENCODE_PERMISSION`.
- **`network` has no layer of the client** (no domain allowlist in OpenCode [V]); it needs the sandbox.
- **`NotFound` for an unknown conversation is not produced.** `session/load` of an unknown id gives
  `-32603 "OpenCode service failure"` [V], which `normalizeError` cannot tell from other failures.
- **`ModelInfo` has no `reasoning` or `attachment`**, which the catalog of the client knows.
- **The conformance cache** is keyed by `adapterVersion` alone; the adapter joins its own version and
  the client's (`0.1.0+opencode.1.19.5`), and the adapter cannot read the client version, so the
  builder passes it.
- **Headless** (`run --format json`) is unmeasured [N]: no translation of its stream, `onAsk` has no
  layer there, and `--auto` is never used.
- **A killed process** ends a pending prompt with "ACP connection closed" [V]; the base maps it to
  `AdapterUnavailable`.
