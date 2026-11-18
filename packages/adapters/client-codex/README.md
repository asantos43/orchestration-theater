# @otheater/adapter-client-codex

`CodexAdapter`, the `ClientAdapter` of `@otheater/core` for the official Codex client, through its
ACP adapter `codex-acp` (^2.6.0), which talks to `codex app-server`. It also holds the Codex
`ModelCatalog`. It starts nothing real in its tests: the command is a constructor option (proposed
key `clients.codex.command`, default `codex-acp`), and the adapter is never an npm dependency of
this package (decision N45).

Facts are marked **[V]** verified here (Phase 0 spikes), **[S]** secondary source (documentation or
schema), **[N]** unconfirmed. Keys below are **[proposta]**: the owner decides.

## What it translates

| Port member | Codex | Source |
| --- | --- | --- |
| `processModel` | `multi-session`: one adapter, one app-server, N sessions (3 in parallel) | [V] `s5-concurrency` |
| `profileEnv` | `CODEX_HOME` = the profile directory | [V] |
| `prepareProfile` | writes `config.toml` (`cli_auth_credentials_store`, `sandbox_mode`, `approval_policy`) in the profile directory only; never reads or writes credentials | [V] the store key; [S] the other two |
| `sessionSetup` (ACP) | pins `mode` (default `workspace-write`) after `session/new` and after `session/load` | [V] both reset the mode to `agent` |
| `sessionSetup` (headless) | `codex exec --json --sandbox <sandbox of the mode>`; a role with MCP servers is refused | [S]/[N] flags; transport not written here |
| `enforcement` | `onAsk` client+daemon, `bypass` daemon, `writeScope` client, `mcpServers` client, `mcpTools` daemon (the grant of the framework server lists only the tools of the role; client in headless, which refuses MCP); nothing for `nativeTools`, `nativeShell`, `network` (only layer 3) | [V] |
| `mcpTools`, `nativeShell: shells` (Phase 4, P1) | no key: how Codex approves an MCP call, and whether `config.toml` can name a tool, is [N] (the page of the config reference was not read). The setup does not change with them; the MCP request reaches layer 2 and is rejected, as before | [N] |
| `normalizeUpdate` | ACP updates; `usage_update` becomes `usage`; `session_info_update` is dropped | [V] |
| `normalizeError` | `data.codexErrorInfo` (`usageLimitExceeded` quota, `unauthorized`, connection kinds transient, `sandboxError`); `-32000` "Authentication required" is auth | [V] quota and auth; [S] the other kinds |
| `mapConfig` | `model`, `reasoning_effort`, `mode` (ids of the client; the veto is `modeVeto`) | [V] |
| `modeVeto` | allow-list of modes (`allowedModes`); a refusal reason, or `null` | [V] |
| `models` | `automatic`, family `openai`, built from the `session/new` config options; no model call | [V] |
| `quota` | `CodexQuotaProbe`: a short `codex app-server` per read, in the profile (`CODEX_HOME`); `account/rateLimits/read` becomes windows (`5h`, `7d`) with `resetsAt` and `planType`; no login is `AdapterUnavailable`, so the profile stays `unknown`; see Quota probe | [V] the protocol on codex-cli 0.170.0 (Phase 0 and the types); [N] the rest, see Quota probe |
| `login`, `logout`, `probeLogin` | the official `codex login` / `codex logout` in the profile; see Official login and logout | [V] the commands exist in `--help`; [N] the rest |
| `probes` | `codex-mode-veto` (offline), `codex-pinned-mode` (needs an injected `readSessionMode`) | [V] |

## The mode veto

`agent` ("Auto review") and `agent-full-access` can never be selected: the adapter does not ask for
them, and the `modeVeto` hook of the `ClientAdapter` base refuses them (`PermissionDenied`) before
any mode change reaches the client: the initial mode of the setup, `configOptionsFor`, and
`session.setConfig('mode', ...)` on an open session, also in a shared process. The refusal does not
depend on the transport. Phase 0 could not remove them from the catalog by
any of 6 override variants [V], and in `agent` the escalation goes to the Guardian Review and
never reaches the client [V], so a veto at the adapter is the only way to keep `bypass` guaranteed
by the daemon. The allowed modes are a list (`allowedModes`, [proposta] `clients.codex.modes`),
default `read-only` and `workspace-write`; a vetoed mode in the list is refused at construction.

## Things the owner must know

- **`/tmp` is writable in `workspace-write`** [V]: no request reaches the client. A path outside
  `/tmp` and the worktree is blocked and asks [V]. So `writeScope: ['client']` is not complete for
  `/tmp`; layer 3 (the sandbox) must close it. `CODEX_HOME/requirements.toml` is not read [V]; a
  system `/etc/codex/requirements.toml` is untested [N].
- **An untitled session spawns one extra thread** (to name it) [V, n=3 per arm]. Calling
  `session/set_title` before the first prompt avoids it [V]. The adapter cannot do it (the port has
  no hook); the transport can. [proposta]
- **`processModel` is `multi-session`**, but the base `ClientAdapter` only starts
  `process-per-session`. The adapter reports the measured value; tests override it. The session
  pool (P8) is the place to close this.
- **`command(profile, via)` receives the transport id** (P13). Codex starts the same `codex-acp`
  for both; a headless transport still has to start `codex` itself from `setup.args`.
- **Quota**: `usageLimitExceeded` carries a time of day without a date ("try again at 9:31 AM")
  [V], so the reset is only taken from `data.resetsAt` when present [N]; the message is not parsed
  (N42). The rate-limit windows are only readable with `account/rateLimits/read` on the app-server
  [V]; that probe arrives in Phase 5.
- **`session/load` resets config options to the defaults** [V], hence the mode is pinned again on
  every load.

## Configuration [proposta]

`clients.codex.command`, `clients.codex.initial_mode`, `clients.codex.modes`,
`clients.codex.credentials_store` (`file`, `keyring`, `auto`), `clients.codex.approval_policy`
(`on-request`, `untrusted`), `clients.codex.suggested_effort`.
`clients.codex.version_source` (`auto`, `package_json`, `initialize`, `config`; see Client version).
`clients.codex.quota.command`, `clients.codex.quota.timeout` (default `15s`), `clients.codex.quota.watch`
(`off` by default, or `resident`), `clients.codex.quota.windows` (default none; see Quota probe).

## Quota probe (Phase 5, P7)

`adapter.quota` starts `codex app-server` with `CODEX_HOME` set to the profile directory and the
profile directory as the working directory, sends `initialize`, `initialized` and
`account/rateLimits/read`, and ends the process tree (process group) when it has the answer, when
the timeout passes, or on dispose. It never calls `account/read` nor `account/rateLimits/consume*`,
and no code of the probe imports `node:fs`: a test checks that only `config.toml` of the profile is
touched (by `prepareProfile`) and that `auth.json` is not. The profile directory comes from the
`profileDir` option (the port's `ProfileRef` carries none); the daemon passes the one of the
profile registry. Without it the probe refuses with `AdapterUnavailable`.

- Windows: `windowDurationMins` 300 is `5h`, 10080 is `7d`, any other length is named by its unit
  (`2d`, `90m`), a missing length by the slot (`primary`, `secondary`). `resetsAt` is epoch seconds
  in the protocol and milliseconds in the reading [V].
- No login: the read fails with `AdapterUnavailable`, and the `QuotaService` leaves the profile
  `unknown` once the last reading is stale. It is never `exhausted` [V, fake app-server and
  service test]. The text of the real error is [N]; the probe also matches a process that exits
  saying "Authentication required".
- `limit_reached`: a reached limit with no window at 100% becomes a window `limit_reached` at 100%
  with no reset [proposta]. `ordinaryUsageAllowed` is not mapped [N].
- `watch: resident` keeps one app-server open per watched profile (about 114 MB each, Phase 0 [V]),
  delivers the first read and merges each sparse `account/rateLimits/updated` into the last view
  [N, merge rule]. `off` (default) starts nothing. In Phase 0 `updated` did not arrive without a
  model turn [V], so polling stays on in `resident` (delivery `both`). A resident process that
  dies is not restarted by the probe.
- Not confirmed [N]: whether starting the app-server counts quota; the behavior of `updated`
  during real turns; whether `excludeResetCreditDetails` is accepted by older versions; what an
  API-key profile answers (probably no windows, which is `AdapterUnavailable`).
- `app-server-types.ts` is a reduced declaration made by hand from `codex app-server generate-ts`
  (codex-cli 0.170.0, run once on 2026-11-18 with an empty `CODEX_HOME`) [V]; the parser trusts none
  of it.

## Official login and logout (Phase 5, P3)

`login(profile)` first runs `prepareProfile` (so `cli_auth_credentials_store = "file"` is in the
profile before the client writes anything), then runs the official command with
`CODEX_HOME` = the profile directory, and returns a `LoginFlow` with the mode, the first URL, a code
for `device_code`, `complete()` (resolves on exit 0) and `cancel()` (kills the tree; `complete()`
rejects with `Cancelled`). A refusal, a signal or the timeout reject with `PermissionDenied`. The
adapter never reads a token or a credentials file and calls no OAuth endpoint; the output of the
client is never logged.

| Mode | Command | Source |
| --- | --- | --- |
| `browser` (default) | `codex login` | [V] exists in `--help`; [proposta] as the default |
| `device_code` | `codex login --device-auth` | [V] the flag is in `--help` |
| `terminal` | `codex login` (no wait for a URL) | [proposta] |
| logout | `codex logout` | [V] exists in `--help` |

`--with-api-key` and `--with-access-token` also exist [V] but are not used: keys go through the
vault and the environment (P2).

`probeLogin(profile, via, cwd?)` opens a session through the given transport with a deny-all policy
and closes it at once. `-32000 "Authentication required"` (or an `auth_required` the transport
already typed) is `logged_out` [V, Phase 0 item 6]; a session that opens is `logged_in`; any other
failure goes up, because it says nothing about the login.

| Option | Key | Modes | Default |
| --- | --- | --- | --- |
| `login.mode` | `clients.codex.login.mode` | `browser`, `device_code`, `terminal` | `browser` |
| `login.command` | `clients.codex.login.command` | any executable and arguments (replaces the default of the mode) | per mode, table above |
| `login.logoutCommand` | `clients.codex.login.logout_command` | any executable and arguments | `codex logout` |
| `login.urlWaitMs` | `clients.codex.login.url_wait_ms` | milliseconds `login()` waits for the URL (and the code) | `15000` |
| `login.timeoutMs` | `clients.codex.login.timeout_ms` | milliseconds of the whole flow before the client is ended | `600000` |

All of these are [proposta]. [N]: what the commands print (the URL and the device code shapes),
the exit codes, whether `codex login` runs without a TTY. `LoginFlow` has no input channel. The tests
use a fake client; no real login ran.

## Client version (N63)

The conformance cache is keyed by the version of the client (`security.conformance:
on_version_change`), so the daemon needs to know it. Three keys, read by the daemon and never by
this package:

| Key | Modes | Default |
| --- | --- | --- |
| `clients.<id>.version_source` | `auto` (the `package.json`, then the `initialize` confirms or corrects it), `package_json`, `initialize`, `config` | `auto` |
| `clients.<id>.client_version` | a version string; a written value (not `unknown`) wins in every mode and nothing corrects it | `unknown` |
| `clients.<id>.version_packages` | the npm package names that identify the install | `CODEX_ACP_PACKAGES` |

- The `package.json` is found without running anything: the command is looked up in `PATH`, the link
  is followed to the real file, and the folders above it are searched for a `package.json` whose
  `name` is one of `version_packages` (this package exports `CODEX_ACP_PACKAGES`, the default: `@agentclientprotocol/codex-acp`).
  `npx`, a wrapper script, a standalone binary or a missing package leaves the version `unknown`,
  without an error.
- The `initialize` of every session may say `agentInfo` (optional in ACP). When its version differs
  from the one known, the adapter takes it, the cache key changes (so the probes run again) and the
  daemon logs one `info` line. A missing `agentInfo` keeps the version read. Phase 0 [V]: `codex-acp` reports its own version (2.6.0 then), not the one of the Codex CLI.
- The headless output has no `initialize`: there only the `package.json` (or `client_version`) counts.

## Tests

Unit tests of each translation (hand-built fixtures in `src/fixtures/`, marked as such, no personal
data) and the `@otheater/sdk` conformance suites for `ClientAdapter` and `AgentSession`, run over
the in-memory fakes of `@otheater/core/testing` (the `adapter-isolation` rule forbids importing
`session-acp`). `src/codex.real.test.ts` is off unless `OT_TEST_REAL_CLIENTS=1` (and
`OT_TEST_REAL_PROMPTS=1` for a model turn); it is written, never run (N57).
