import { appendFileSync } from "node:fs"
import { memo, useRef, useState, useSyncExternalStore } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { Scenario } from "./args.ts"
import type { Msg, Step, Store } from "./store.ts"

const C = {
  acc: "#8190ff",
  dim: "#9aa3af",
  text: "#e6e8ec",
  line: "#3a4150",
  ok: "#5fd39a",
  warn: "#f0b45a",
  err: "#f06a6a",
  you: "#7dd3fc",
}

// OT_KEYLOG=arquivo registra cada tecla recebida (para a matriz de atalhos da Fase 0)
const KEYLOG = process.env.OT_KEYLOG
const SIDE_W = 30
const RAIL_W = 5
const MIN_CHAT = 30
const MIN_PANEL = 24
const STEP = 4

const CAST: [string, string, string, string][] = [
  ["●", C.acc, "loja-api", "#14 exec"],
  ["!", C.warn, "relatorio-mensal", "você"],
  ["✗", C.err, "app-mobile", "crít 2/2"],
  ["○", C.dim, "pesquisa-acp", "ocioso"],
  ["✓", C.ok, "migracao-db", "#9 ok"],
]
const QUOTA: [string, number, string][] = [
  ["cc/empresa", 62, C.ok],
  ["cc/pessoal", 91, C.warn],
  ["cx/conta-1", 34, C.ok],
  ["oc/minimax-api", 16, C.acc],
]
const bar = (w: number, pct: number) => {
  const f = Math.round((w * pct) / 100)
  return "█".repeat(f) + "░".repeat(w - f)
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const MessageView = memo(function MessageView({ m }: { m: Msg }) {
  const you = m.role === "user"
  return (
    <text wrapMode="word" marginBottom={1}>
      <span fg={you ? C.you : C.acc}>{you ? "você" : "diretor"}</span>
      <span fg={C.dim}>{" · " + m.time}</span>
      {"\n" + m.text}
    </text>
  )
})

const StepView = memo(function StepView({ s }: { s: Step }) {
  return (
    <text wrapMode="none">
      <span fg={C.dim}>{String(s.id).padStart(4, "0") + " "}</span>
      <span fg={s.ok ? C.ok : C.err}>{s.ok ? "✓ " : "✗ "}</span>
      <span fg={C.acc}>{s.kind.padEnd(5) + " "}</span>
      {s.detail}
    </text>
  )
})

function Header({ store, scenario }: { store: Store; scenario: Scenario }) {
  const msgs = useSyncExternalStore(store.subscribe, store.getMessages)
  const steps = useSyncExternalStore(store.subscribe, store.getSteps)
  const done = useSyncExternalStore(store.subscribe, store.getStreamDone)
  const info = scenario.kind === "stream" ? `stream ${scenario.rate}/s${done ? " (fim)" : ""}` : "history"
  return (
    <box height={1} flexDirection="row" backgroundColor="#232734">
      <text fg={C.acc}> ◆ ot </text>
      <text fg={C.text}>{"│ loja-api › Peça #14 · Login OAuth │ " + info}</text>
      <box flexGrow={1} />
      <text fg={C.dim}>{`msgs ${msgs.length} · passos ${steps.length} · daemon 127.0.0.1:7420 ● `}</text>
    </box>
  )
}

function Sidebar({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return (
      <box width={RAIL_W} border borderStyle="rounded" borderColor={C.line} flexDirection="column" flexShrink={0}>
        <text fg={C.acc}> » </text>
        {CAST.map(([ic, col, name]) => (
          <text key={name} fg={col}>{` ${name[0]!.toUpperCase()}${ic}`}</text>
        ))}
        <text fg={C.line}>───</text>
        {QUOTA.map(([n, p, col]) => (
          <text key={n} fg={col}>{bar(3, p)}</text>
        ))}
      </box>
    )
  }
  return (
    <box width={SIDE_W} border borderStyle="rounded" borderColor={C.line} title="Navegação" flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <text fg={C.dim}>▾ ELENCO (cenários)</text>
      {CAST.map(([ic, col, name, st], i) => (
        <text key={name} fg={i === 0 ? C.text : undefined} bg={i === 0 ? "#2a3150" : undefined}>
          <span fg={col}>{ic + " "}</span>
          {name.slice(0, 14).padEnd(14) + st.padStart(10)}
        </text>
      ))}
      <text> </text>
      <text fg={C.dim}>▾ ASSINATURAS  █ 5h</text>
      {QUOTA.map(([n, p, col]) => (
        <box key={n} flexDirection="column">
          <text>
            <span fg={C.text}>{n.padEnd(16)}</span>
            <span fg={col === C.warn ? C.warn : C.dim}>{(p + "%" + (col === C.warn ? " !" : "")).padStart(10)}</span>
          </text>
          <text fg={col}>{bar(26, p)}</text>
        </box>
      ))}
    </box>
  )
}

function Chat(props: {
  store: Store
  width: number | undefined
  focused: boolean
  scrollRef: React.RefObject<ScrollBoxRenderable | null>
}) {
  const msgs = useSyncExternalStore(props.store.subscribe, props.store.getMessages)
  const inputRef = useRef<InputRenderable | null>(null)
  const submit = (v: string) => {
    const t = v.trim()
    if (!t) return
    props.store.addUser(t)
    if (inputRef.current) inputRef.current.value = ""
  }
  return (
    <box
      width={props.width}
      flexGrow={props.width === undefined ? 1 : 0}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={props.focused ? C.acc : C.line}
      title="Chat · Orquestrador (claude-haiku-low@claude-code/empresa)"
      flexDirection="column"
    >
      <scrollbox ref={props.scrollRef} flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
        {msgs.map((m) => (
          <MessageView key={m.id} m={m} />
        ))}
      </scrollbox>
      <box height={2} border={["top"]} borderStyle="rounded" borderColor={C.line} flexDirection="row" paddingLeft={1}>
        <text fg={C.acc}>{"› "}</text>
        <input ref={inputRef} focused flexGrow={1} placeholder="Fale com o Orquestrador…" onSubmit={submit} />
      </box>
    </box>
  )
}

function Panel(props: {
  store: Store
  focused: boolean
  scrollRef: React.RefObject<ScrollBoxRenderable | null>
}) {
  const steps = useSyncExternalStore(props.store.subscribe, props.store.getSteps)
  return (
    <box flexGrow={1} border borderStyle="rounded" borderColor={props.focused ? C.acc : C.line} title="Trajetórias" flexDirection="column">
      <scrollbox ref={props.scrollRef} flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1}>
        {steps.map((s) => (
          <StepView key={s.id} s={s} />
        ))}
      </scrollbox>
    </box>
  )
}

export function App({ store, scenario, onQuit }: { store: Store; scenario: Scenario; onQuit: () => void }) {
  const { width, height } = useTerminalDimensions()
  const [sideOpen, setSideOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(true)
  const [chatCols, setChatCols] = useState<number | null>(null)
  const [focus, setFocus] = useState<"chat" | "panel">("chat")
  const chatScroll = useRef<ScrollBoxRenderable | null>(null)
  const panelScroll = useRef<ScrollBoxRenderable | null>(null)

  // Em janelas estreitas a lateral vira trilho, mesmo aberta.
  const sideCollapsed = !sideOpen || width < 100
  const sideW = sideCollapsed ? RAIL_W : SIDE_W
  const avail = Math.max(0, width - sideW)
  const maxChat = Math.max(MIN_CHAT, avail - MIN_PANEL)
  const wanted = chatCols ?? Math.floor(avail * 0.6)
  const chatW = panelOpen ? clamp(wanted, MIN_CHAT, maxChat) : undefined

  useKeyboard((key) => {
    if (KEYLOG) appendFileSync(KEYLOG, JSON.stringify({ name: key.name, ctrl: key.ctrl, meta: key.meta, option: key.option, shift: key.shift, seq: key.sequence, src: key.source }) + "\n")
    const alt = key.meta || key.option
    const mod = key.ctrl || alt
    const eat = () => {
      key.preventDefault()
      key.stopPropagation()
    }
    if (key.ctrl && key.name === "q") return onQuit()
    if (mod && key.name === "b") {
      eat()
      setSideOpen((v) => !v)
    } else if ((mod && key.name === "j") || key.name === "linefeed") {
      // em modo bruto o Ctrl+J chega como "linefeed" (LF), distinto do Enter ("return", CR)
      eat()
      setPanelOpen((v) => !v)
      if (panelOpen) setFocus("chat")
    } else if (key.ctrl && (key.name === "left" || key.name === "right")) {
      eat()
      const base = chatW ?? wanted
      setChatCols(clamp(base + (key.name === "right" ? STEP : -STEP), MIN_CHAT, maxChat))
    } else if (key.name === "tab") {
      eat()
      if (panelOpen) setFocus((f) => (f === "chat" ? "panel" : "chat"))
    } else if (key.name === "pageup" || key.name === "pagedown") {
      eat()
      const ref = focus === "panel" && panelOpen ? panelScroll : chatScroll
      ref.current?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport")
    }
  })

  const hints = `^B lateral · ^J painel · ^←/→ largura (${chatW ?? "auto"}) · Tab foco: ${focus} · PgUp/PgDn rola · Enter envia · ^Q sai · ${width}x${height}`
  return (
    <box flexDirection="column" width="100%" height="100%">
      <Header store={store} scenario={scenario} />
      <box flexDirection="row" flexGrow={1}>
        <Sidebar collapsed={sideCollapsed} />
        <Chat store={store} width={chatW} focused={focus === "chat"} scrollRef={chatScroll} />
        {panelOpen && <Panel store={store} focused={focus === "panel"} scrollRef={panelScroll} />}
      </box>
      <text height={1} fg={C.dim}>{hints}</text>
    </box>
  )
}
