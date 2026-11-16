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
| `enforcement` | `onAsk` client+daemon, `bypass` daemon, `writeScope` client, `mcpServers` client; nothing for `nativeTools`, `nativeShell`, `network` (only layer 3) | [V] |
| `normalizeUpdate` | ACP updates; `usage_update` becomes `usage`; `session_info_update` is dropped | [V] |
| `normalizeError` | `data.codexErrorInfo` (`usageLimitExceeded` quota, `unauthorized`, connection kinds transient, `sandboxError`); `-32000` "Authentication required" is auth | [V] quota and auth; [S] the other kinds |
| `mapConfig` | `model`, `reasoning_effort`, `mode` (allow-list) | [V] |
| `models` | `automatic`, family `openai`, built from the `session/new` config options; no model call | [V] |
| `quota`, `login`, `logout` | reject with `AdapterUnavailable` (Phase 5) | n/a |
| `probes` | `codex-mode-veto` (offline), `codex-pinned-mode` (needs an injected `readSessionMode`) | [V] |

## The mode veto

`agent` ("Auto review") and `agent-full-access` can never be selected: the adapter does not ask for
them, `mapConfig` refuses them (`PermissionDenied`), and `guardTransport` wraps a transport so that
`session.setConfig('mode', ...)` is refused too. Phase 0 could not remove them from the catalog by
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
- **`command(profile)` has no `via`**, so a headless transport has to start `codex` itself from
  `setup.args`.
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

## Tests

Unit tests of each translation (hand-built fixtures in `src/fixtures/`, marked as such, no personal
data) and the `@otheater/sdk` conformance suites for `ClientAdapter` and `AgentSession`, run over
the in-memory fakes of `@otheater/core/testing` (the `adapter-isolation` rule forbids importing
`session-acp`). `src/codex.real.test.ts` is off unless `OT_TEST_REAL_CLIENTS=1` (and
`OT_TEST_REAL_PROMPTS=1` for a model turn); it is written, never run (N57).
