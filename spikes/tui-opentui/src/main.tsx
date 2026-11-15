import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { appendFileSync } from "node:fs"
import { parseArgs } from "./args.ts"
import { Store } from "./store.ts"
import { App } from "./App.tsx"

const scenario = parseArgs(process.argv.slice(2))
const store = new Store()

// Ctrl+C não sai (o contrato é Ctrl+Q); o renderizador fica com o teclado inteiro.
const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: false })
const quit = () => {
  renderer.destroy()
  process.exit(0)
}
createRoot(renderer).render(<App store={store} scenario={scenario} onQuit={quit} />)
store.start(scenario)

// OT_MEMLOG=arquivo grava process.memoryUsage() a cada 5 s (diagnóstico de crescimento de RSS)
if (process.env.OT_MEMLOG) {
  const f = process.env.OT_MEMLOG
  setInterval(() => {
    const m = process.memoryUsage()
    appendFileSync(f, JSON.stringify({ t: Math.round(process.uptime()), rss: m.rss >> 20, heapUsed: m.heapUsed >> 20, heapTotal: m.heapTotal >> 20, external: m.external >> 20, ab: m.arrayBuffers >> 20 }) + "\n")
  }, 5000).unref()
}
