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
| `nativeShell: 'none'` | `Bash` out of `tools`, in `disallowedTools` and in `permissions.deny` | client | [V] |
| `mcpServers` | `strictMcpConfig: true`; servers go through `session/new` | client | [V] |
| `onAsk: 'reject'` | mode `default` so every request reaches the daemon, which answers `reject_once` | client, daemon | [V] |
| `bypass: 'forbidden'` | `allowDangerouslySkipPermissions: false` and `disableBypassPermissionsMode` in the profile `settings.json` | client | [V] |
| `writeScope`, `network` | none: the client has no key for them | none (needs a sandbox) | [V] |

Also [V]: `permissions.defaultMode` in `_meta` is ignored (the mode belongs to ACP and starts at
`auto`), so the session setup sets the mode `default` through the `mode` config option; and a
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
| `command` | `clients.claude-code.command` | any executable and arguments | `claude-agent-acp` [S: bin name of the package, not run] |
| `settingSources` | `clients.claude-code.setting_sources` | `none`, `project`, `user` | `none` |
| `utilizationUnit` | `clients.claude-code.utilization_unit` | `ignore`, `fraction`, `percent` | `ignore` |
| `accountEnv` | `clients.claude-code.account_env` | `strip`, `keep` | `strip` |
| `modelCatalog.source` | `clients.claude-code.model_catalog` | `session`, `reserve`, `session_or_reserve` | `session_or_reserve` |
| `modelCatalog.cacheMs` | `clients.claude-code.model_catalog_cache_ms` | milliseconds, `0` for none | `300000` |

`accountEnv: 'strip'` removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` from the base environment, because they win over the login of the profile
[S]. The adapter never reads their values. The profile directory is passed as `CLAUDE_CONFIG_DIR`
[V].

## Modes it refuses

`mapConfig` throws `InvalidInput` for `bypassPermissions` (it skips layer 2) [V], `dontAsk` (not in
the mode catalog, never reaches layer 2) [V] and `auto` (a classifier would answer instead of layer
2; not measured) [N].

## Conformance probe

`claude-sh-c-reject` asks the model to run `sh -c "touch otheater-probe.txt"` in a scratch
directory under the policy of a role, and fails if the file exists afterwards. It sends a prompt, so
`probes()` returns it only when the `probe` option is given. It checks the end result, not which
layer stopped the command.

## Not here yet

- `login` and `logout` reject with `AdapterUnavailable` (Phase 5).
- The `QuotaProbe` declares no window and `read` rejects (Phase 5).
- Profiles that use an API key (needs the secret vault in `profileEnv`).

## Tests

`pnpm vitest run packages/adapters/client-claude-code` runs everything offline: the translations,
fixtures made by hand in `src/fixtures/` (marked as such), and both conformance suites of the SDK
over `FakeSessionTransport` and `FakeProcessLauncher`. `src/claude-code.real.test.ts` talks to the
real adapter and is skipped unless `OT_TEST_REAL_CLIENTS=1` (initialize, config options and
`session/new` in an empty temporary profile) or `OT_TEST_REAL_PROMPTS=1` plus
`OT_TEST_CLAUDE_PROFILE_DIR` (turns that send a prompt).
