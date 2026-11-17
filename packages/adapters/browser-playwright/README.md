# @otheater/adapter-browser-playwright

`PlaywrightBrowserSession`, the `BrowserSession` of `@otheater/core` over
[`playwright-core`](https://playwright.dev) and a Chromium that the daemon runs itself
(architecture 5.19, decisions N40, N93, N95). It is the browser of the agents of Phase 4 ("navegador
sem a tela"): no window, no extension, no account of the Producer in it.

Facts are marked **[V]** verified here (Chromium revision 1248 of `playwright-core` 1.64.1, on Linux),
**[S]** secondary source and **[N]** unconfirmed. Keys are **[proposta]** (the owner decides). Every
test opens pages served by the test itself on 127.0.0.1, never the internet.

## What it does

- Chromium is a child of the `ProcessLauncher` (5.9), started headless with
  `--remote-debugging-port=0` and driven through `connectOverCDP`. Playwright never spawns it, so the
  launcher's limits and cleanup apply to it [V]. The flags are in `chromium.ts` (`CHROMIUM_ARGS`).
- RAM admission before a start (5.9): the free memory and the number of browsers
  (`browser.min_free_memory_mb`, `browser.max_instances`). A refusal is `AdapterUnavailable`.
- Profiles: `shared` is one profile, one browser, a page for each scenario; `per_scenario` is a
  browser and a profile directory for each. The browser of `shared` closes with its last scenario;
  the directory stays on disk. `extension` and `import` are not here (Phase 12).
- The guard: ONE `context.route` sends every request of every page (navigations, sub-resources,
  redirects, popups) to the guard of the scenario that owns the page. The daemon writes the rule; the
  adapter only asks. A guard that throws counts as a refusal [V].
- `file:` is never opened by the browser: the route aborts it before the guard is asked [V]. The
  daemon serves the files it allows on its own origin, behind a token (see the daemon's
  `browser/file-origin.ts`).
- Refs: the `ref` of an element is the one `ariaSnapshot({ mode: 'ai' })` printed on the last `read`.
  A ref the page does not know is `NotFound`.
- Cookies are never read, and the value of a password field never leaves: the tree is redacted by
  the adapter (`redact.ts`) [V].
- Downloads are denied. Nothing is installed: the adapter never runs the download of Chromium.

## Chromium

`playwright-core` does not bring a browser. Run `npx playwright-core@1.64.1 install chromium` once (the
`linux` job of CI does, N95); the cache is `~/.cache/ms-playwright`. Without it `open` says so,
naming the command (`AdapterUnavailable`); `browser.executable_path` points at another Chromium.
The package `playwright` is not approved and `playwright install` is not used.

The sandbox of Chromium is on by default (`browser.sandbox`). It works on a normal Linux desktop [V]
and does not on the CI runners (Ubuntu 24.04 refuses user namespaces), where the tests turn it off.

## Things the owner must know

- **The CDP port is open to local processes [N].** `--remote-debugging-port=0` listens on 127.0.0.1
  and any process of the same user can connect and drive the browser, past the guard. The launcher
  does not isolate the network. A pipe (`--remote-debugging-pipe`) would close this, but Playwright
  only speaks it when it spawns the browser itself.
- **WebSockets are not intercepted [N].** `context.route` sees HTTP(S); a page can open a WebSocket
  to a host the guard would refuse. Playwright's `routeWebSocket` was not tried.
- **Service workers [N].** Their requests may skip the route of the page; not verified, and not
  blocked.
- **DNS rebinding to a private address [N].** The guard judges the host name of a request, not the
  address it resolves to. With `browser.local_urls: deny` a public name that resolves to 127.0.0.1
  passes.
- **The first request of a popup [V].** Playwright throws on `request.frame()` for the first request
  of a popup, because the frame does not exist yet. The adapter judges it by the guard of the scenario
  that opened it; with more than one scenario in a shared browser a popup of one that cannot be told
  apart is judged by every acting scenario's guard together (the strictest wins).
- **Chromium policy for `file://` [N].** An enterprise policy that blocks `file:` inside the browser
  (a second lock) was not tried; the route is the only one.
- **Windows and macOS.** The adapter is compiled everywhere, but Windows has no process launcher yet,
  so the daemon has no browser there. macOS and the Windows paths of `file:` URLs were not run [N].

## Tests

`pnpm vitest run packages/adapters/browser-playwright`. The tests with a real Chromium are skipped,
with a message, when it is not in the cache; one browser at most per test, closed in `afterEach`.
`testing/node-process-launcher.ts` is a test double of the launcher (it is not exported).
