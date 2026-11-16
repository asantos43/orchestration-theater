# @otheater/adapter-local-ollama

`OllamaServer`, the `LocalModelServer` of `@otheater/core` for [Ollama](https://github.com/ollama/ollama),
over HTTP (architecture 5.9 and 5.18, decision N71). It is not a client of agents: it only tells
the daemon whether the server is up, which models it has and how many slots it gives. Stateless:
the URL comes with each call. Only `GET`s are sent; no text is generated and no model is loaded.

Facts are marked **[V]** verified here, **[S]** secondary source (documentation read on 2026-11-16:
`docs/api.md` of ollama/ollama, docs.ollama.com `api/ps` and `faq`) and **[N]** unconfirmed. Keys
below are **[proposta]**: the owner decides. No Ollama was started to write this package; its
tests use a fake server.

## What it reads

| Port member | Ollama | Source |
| --- | --- | --- |
| `health` | `GET /api/version` (200 with `{"version"}` is `ok`; 503 is `loading`; anything else is `unreachable`); `GET /` (banner "Ollama is running") and `GET /api/tags` are the other probes | [S] |
| `models` | `GET /api/tags` (installed; Ollama loads a model on the first request) or `GET /api/ps` (loaded now); `contextWindow` from `context_length` of `/api/ps`, only for a loaded model | [S] |
| `slots` | `count` is the configured `parallel`; `contextPerSlot` from `context_length` of `/api/ps` | [N] see below |

`POST /api/show` (`model_info["<arch>.context_length"]`, `parameters`) is not used: the first is the
training context and the second the default of the Modelfile, and neither is the context the server
loaded the model with, which is what `LocalModel.contextWindow` means.

## Things the owner must know

- **`slots` is not in the API [N].** `OLLAMA_NUM_PARALLEL` (default 1 [S: FAQ]) is a variable of the
  server process, and no endpoint read for this package returns it. So `count` only exists when the
  user (or the setup assistant) writes it in `parallel` or `parallel_by_url`; without it `count` is
  `undefined` and `slots: auto` falls back to 1 (5.9). The architecture says `slots: auto` reads
  `OLLAMA_NUM_PARALLEL` **[a confirmar]**: this adapter cannot read the variable of another process.
- **Context per slot differs from llama.cpp.** In llama.cpp `-c` is divided among the `--parallel`
  slots. In Ollama the context of a request is `num_ctx` and the memory grows with the number of
  parallel requests [S: FAQ, "increasing the context size by the number of parallel requests"].
  Whether `context_length` of `/api/ps` is that total or one request's is **[N]**, so the key
  `context_mode` (`total` divides by `parallel`, the safe reading; `per_slot` does not) leaves the
  choice open until someone reads it from a running server.
- **No loading state.** Ollama has no "loading the model" status in its API, and the port is closed
  until it is up [N]. `loading` is only a 503 (a proxy, or a server that answers while it starts).

## Configuration (`adapters.local_model_server.ollama`)

| Key | Values | Default |
| --- | --- | --- |
| `timeout_ms` | positive integer | `5000` |
| `health_probe` | `version`, `root`, `tags` | `version` |
| `models_source` | `installed`, `loaded` | `installed` |
| `context_window` | `loaded`, `none` | `loaded` |
| `context_mode` | `total`, `per_slot` | `total` |
| `parallel` | positive integer | absent (unknown) |
| `parallel_by_url` | base URL to positive integer; wins over `parallel` | `{}` |

`OllamaConfigSchema` validates it (strict: a typo fails at start-up) and `createOllamaServer(config)`
builds the adapter. The daemon does not mount it yet.

## Tests

`pnpm vitest run packages/adapters/local-ollama` runs the `describeLocalModelServerConformance`
suite of `@otheater/sdk` and the tests of this adapter against `FakeOllamaServer` (real HTTP on
`127.0.0.1`, in `src/testing/`). `src/ollama.real.test.ts` talks to a real Ollama only with
`OT_TEST_REAL_OLLAMA=1` and `OT_TEST_OLLAMA_URL`; it sends `GET`s only.
