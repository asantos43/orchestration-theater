# @otheater/adapter-client-claude-code

The Claude Code client of OTheater: `ClaudeCodeAdapter extends ClientAdapter` and the `ModelCatalog`
of the client. It talks to Claude Code through `claude-agent-acp` (ACP) and translates the neutral
`RolePolicy` into the keys of the client, and the client's output into the normalized vocabulary.
The common behavior (`openSession`, `loadSession`, `answerPermission`, `guarantee`,
`checkConformance`) is the base class's and is not overridden.

Source tags used below: **[V]** verified locally in Phase 0 (`spikes/acp-claude/README.md`,
`claude` 2.1.325, adapter 0.107.0), **[S]** from a secondary source (documentation, package
metadata), **[N]** not confirmed (read in code or inferred; nothing here ran against it).

## What it translates

| Policy field | Claude Code key | Layers | Source |
| --- | --- | --- | --- |
| `nativeTools` | `tools` in `_meta.claudeCode.options` | client | [V] |
| `nativeShell: 'none'` or `'shells'` | `Bash` out of `tools`, in `disallowedTools` and in `permissions.deny`, in both values: `shells` are the daemon's own tools and come in as MCP tools | client | [V] |
| `mcpServers` | `strictMcpConfig: true`; servers go through `session/new` | client | [V] |
| `mcpTools` | `allowedTools` and `permissions.allow` with one `mcp__<server>__<tool>` rule per tool of the role (`mcp__<server>` only for `all`); a tool outside the list asks and layer 2 rejects it | client, daemon (the grant lists only these tools) | [S] rule form (code.claude.com/docs/en/permissions, read 2026-11-17); [N] that a real session runs the tool with no request |
| `onAsk: 'reject'` | mode `default` so every request reaches the daemon, which answers `reject_once`; a role whose `nativeTools` has `edit` or `write` starts in `acceptEdits` (N180), which spares the request only for the editing of files; the fence of the writing is the sandbox (layer 3) and the worktree, and the `mode` of the executor still wins | client, daemon | [V] `default` and the refusal of every `Write`/`Edit` of the Actor in it (real `phase6` run, 2026-11-20); [S] `acceptEdits` (code.claude.com/docs/en/permissions, read 2026-11-20); [N] what it does for a path outside the cwd |
| `bypass: 'forbidden'` | `allowDangerouslySkipPermissions: false` and `disableBypassPermissionsMode` in the profile `settings.json` | client | [V] |
| `writeScope`, `network` | none: the client has no key for them | none (needs a sandbox) | [V] |

Also [V]: `permissions.defaultMode` in `_meta` is ignored (the mode belongs to ACP and starts at
`auto`), so the session setup sets the mode of the role (`default`, or `acceptEdits` for a role that writes) through the `mode` config option; and a
`deny` rule is not a boundary (`sh -c` got past `Bash(touch:*)`), which is why the shell is removed
from the tool list instead.

`prepareProfile` writes `permissions.defaultMode`, `disableBypassPermissionsMode` and the managed
tool names in `permissions.deny` into `<profile dir>/settings.json` and nothing else. It never
opens another file of the directory (the credentials live there), and a settings file that is not
a JSON object is left as it is.

### Update and error normalization

- `session/update` -> `NormalizedUpdate`: message and thought chunks, tool calls, plan, commands,
  mode and config changes, usage. [V] for the update names and the `usage_update` fields; the
  `_meta.claudeCode.toolName` key is [N].
- `usage_update._meta["_claude/rateLimit"]` becomes a `rate_limit` update: `status`, `resetsAt`
  (epoch seconds, converted to ms) and the window [V]. The unit of `utilization` is [N], so
  `usedPercent` is left out unless `utilizationUnit` says `fraction` or `percent`. A rate-limit
  message replaces the counters of the same `usage_update`.
- Errors -> `NormalizedError`: auth (JSON-RPC code `-32000`, "authentication required", "please run
  /login") [S], quota (usage or 5-hour or weekly limit, with the reset after a pipe or in `data`)
  [S], client crash, transient (overloaded, 5xx, network) [N], refusal and permission [N]. Phase 0
  could not provoke a quota or auth error, so none of the patterns was captured.

### Model catalog

`discovery: 'automatic'`. The list comes from the `model` and `effort` config options of
`session/new` [V], read by a `ConfigOptionsReader` the daemon plugs in (this package does not start
a client by itself). Sources (`model_catalog`): `session`, `reserve`, `session_or_reserve`
(default). The reserve (`default`, `opus`, `sonnet`, `haiku`) only backs the list up; a model it
lacks is a warning, never an error. Ids ending in `[1m]` get a 1,000,000 token window [S].

## Options (each one is a configuration key the daemon reads) [proposta]

| Option | Key | Modes | Default |
| --- | --- | --- | --- |
| `command` | `clients.claude-code.command` | `{ cmd, args }` or a function that returns it, called at each process start (P13: the daemon passes the managed install run with its Node, or the `PATH` command as a fallback) | `claude-agent-acp` [S: bin name of the package, not run] |
| `settingSources` | `clients.claude-code.setting_sources` | `none`, `project`, `user` | `none` |
| `utilizationUnit` | `clients.claude-code.utilization_unit` | `ignore`, `fraction`, `percent`, `auto` (see Quota probe) | `ignore` |
| `quotaStatusline` | `clients.claude-code.quota_statusline` | `file`, `off` | `file` |
| `accountEnv` | `clients.claude-code.account_env` | `strip`, `keep` | `strip` |
| `modelCatalog.source` | `clients.claude-code.model_catalog` | `session`, `reserve`, `session_or_reserve` | `session_or_reserve` |
| `modelCatalog.cacheMs` | `clients.claude-code.model_catalog_cache_ms` | milliseconds, `0` for none | `300000` |
| `versionSource` | `clients.claude-code.version_source` | `auto`, `package_json`, `initialize`, `config` | `auto` (see Client version) |

`accountEnv: 'strip'` removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` from the base environment, because they win over the login of the profile
[S]. The adapter never reads their values. The profile directory is passed as `CLAUDE_CONFIG_DIR`
[V].

## Client version (N63)

The conformance cache is keyed by the version of the client (`security.conformance:
on_version_change`), so the daemon needs to know it. Three keys, read by the daemon and never by
this package:

| Key | Modes | Default |
| --- | --- | --- |
| `clients.<id>.version_source` | `auto` (the `package.json`, then the `initialize` confirms or corrects it), `package_json`, `initialize`, `config` | `auto` |
| `clients.<id>.client_version` | a version string; a written value (not `unknown`) wins in every mode and nothing corrects it | `unknown` |
| `clients.<id>.version_packages` | the npm package names that identify the install | `CLAUDE_CODE_ACP_PACKAGES` |

- The `package.json` is found without running anything: the command is looked up in `PATH`, the link
  is followed to the real file, and the folders above it are searched for a `package.json` whose
  `name` is one of `version_packages` (this package exports `CLAUDE_CODE_ACP_PACKAGES`, the default: `@agentclientprotocol/claude-agent-acp`).
  `npx`, a wrapper script, a standalone binary or a missing package leaves the version `unknown`,
  without an error.
- The `initialize` of every session may say `agentInfo` (optional in ACP). When its version differs
  from the one known, the adapter takes it, the cache key changes (so the probes run again) and the
  daemon logs one `info` line. A missing `agentInfo` keeps the version read. Phase 0 [V]: `claude-agent-acp` reports its own version (0.107.0 then), not the one of Claude Code.
- The headless output has no `initialize`: there only the `package.json` (or `client_version`) counts.

## Modes it refuses

The `modeVeto` hook of the `ClientAdapter` base refuses (`PermissionDenied`, on the setup, on
`configOptionsFor` and on `session.setConfig('mode', ...)`) `bypassPermissions` (it skips layer 2) [V], `dontAsk` (not in
the mode catalog, never reaches layer 2) [V] and `auto` (a classifier would answer instead of layer
2; not measured) [N].

## Conformance probe

`claude-sh-c-reject` asks the model to run `sh -c "touch otheater-probe.txt"` in a scratch
directory under the policy of a role, and fails if the file exists afterwards. It sends a prompt, so
`probes()` returns it only when the `probe` option is given. It checks the end result, not which
layer stopped the command.

## Official login and logout (Phase 5, P3)

`login(profile)` runs the official command of the client inside the profile (`CLAUDE_CONFIG_DIR`
= the profile directory, API-key variables stripped as above) and returns a `LoginFlow`: the mode
(`browser` by default), the first URL the client printed, a code when the mode is `device_code`, and
`complete()`, which resolves when the command exits 0. `cancel()` ends the process tree and
`complete()` then rejects with `Cancelled`; a refusal, a signal or the timeout reject with
`PermissionDenied`. The adapter never reads, writes or prints a token and never calls an OAuth
endpoint: the client does the login, the adapter only reads the URL and the code from its output.
The output is never logged.

| Command | Default | Source |
| --- | --- | --- |
| login | `claude auth login --claudeai` | [V] the options of `--help` (`--claudeai`, `--console`, `--email`, `--sso`); [proposta] the default |
| logout | `claude auth logout` | [V] exists in `--help`; [N] the output |
| status (probe) | `claude auth status --json` | [V] exists in `--help` (`--json`, `--text`); [N] the JSON |

`probeLogin(profile)` runs the status command and reads only the boolean `loggedIn`; anything else
(a failure, text that is not JSON, no such field) is `unknown`, never "logged out" by guess. The
status command is the probe because `session/new` works without a login [V], so ACP cannot tell.

| Option | Key | Modes | Default |
| --- | --- | --- | --- |
| `login.mode` | `clients.claude-code.login.mode` | `browser`, `device_code`, `terminal` | `browser` |
| `login.command` | `clients.claude-code.login.command` | any executable and arguments (replaces the default of the mode) | `claude auth login --claudeai` |
| `login.logoutCommand` | `clients.claude-code.login.logout_command` | any executable and arguments | `claude auth logout` |
| `login.urlWaitMs` | `clients.claude-code.login.url_wait_ms` | milliseconds `login()` waits for the URL (and the code) | `15000` |
| `login.timeoutMs` | `clients.claude-code.login.timeout_ms` | milliseconds of the whole flow before the client is ended | `600000` |
| `login.statusCommand` | `clients.claude-code.login.status_command` | any executable and arguments | `claude auth status --json` |

All of these are [proposta]. [N]: what the commands print (the shape of the URL), whether they run
without a TTY, the exit codes, and the JSON of `auth status`. `LoginFlow` has no input channel, so a
step where the client asks the owner to paste a code back is also [N]. The tests use a fake client
(`src/testing/fake-official-client.ts`) that imitates the output; no real login ran.

## Quota probe (Phase 5, P6)

Two sources, both without calling a model or the network, and without a real client in the tests.

- **Statusline file** (`ClaudeQuotaProbe`). `prepareProfile` writes `otheater-statusline.mjs` in the
  profile directory and sets `statusLine` in the `settings.json` there to run it with the `node`
  that runs the daemon (`quotaStatusline: file`; `off` installs nothing and removes our own command,
  and a `statusLine` that is not ours is kept in that mode). The command reads the stdin of the
  client, keeps only `used_percentage` and `resets_at` of `rate_limits.five_hour|seven_day`, writes
  them with the time to `otheater-quota.json` (temporary file and rename, mode 0600), prints nothing,
  and leaves the file alone when `rate_limits` is not there (the first call of a session) [V:
  Phase 0, item 1]. `read` gives the windows `5h` and `7d` with the reset; a window past its reset is
  dropped (the client drops it too) [S]. With no file, no `rate_limits`, no open window or a value
  outside 0..100, `read` rejects with `AdapterUnavailable` and the reason, so the profile is
  `unknown`; a value is never clamped. The file is read without following a link: `lstat`,
  `O_NOFOLLOW`, a hard-link check, the real path inside the profile directory and a size cap.
  `watch` polls the file every 2 s and delivers each new observation. The number is the one of the
  last reply of a real session, so the freshness is the `QuotaService`'s to judge. The resolution is
  about one point (`approximate`) [V]. The `--settings` `statusLine` wins over the user's [V], and the
  workspace has to be trusted [S].
- **Stream signal** (`quotaSignalsOf`). The `rate_limit_event` of a `usage_update` becomes the
  signals of `_otheater/quota/signal`: a `window` signal for each window whose `utilization` the unit
  rule accepts, with the window name of the daemon and the reset in ISO, and a `limit_hit` when the
  status is `rejected`. The unit of `utilization` (N123) is [N] for a high value: `auto` takes 0..1
  as a fraction and above 1 as a percentage and records the unit it saw; `fraction` and `percent`
  fix it; `ignore` (the default, today's behavior) gives only the `limit_hit`. Whatever falls outside
  0..100 is refused with the reason in every mode.

[N]: the statusline on a real client of this machine was not run in the tests (that is the optional
`quota` level, N122); the file and the signals are checked with fixtures whose values are invented.

## Not here yet

- Profiles that use an API key (needs the secret vault in `profileEnv`).

## Tests

`pnpm vitest run packages/adapters/client-claude-code` runs everything offline: the translations,
fixtures made by hand in `src/fixtures/` (marked as such), and both conformance suites of the SDK
over `FakeSessionTransport` and `FakeProcessLauncher`. `src/claude-code.real.test.ts` talks to the
real adapter and is skipped unless `OT_TEST_REAL_CLIENTS=1` (initialize, config options and
`session/new` in an empty temporary profile) or `OT_TEST_REAL_PROMPTS=1` plus
`OT_TEST_CLAUDE_PROFILE_DIR` (turns that send a prompt).
