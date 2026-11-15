import { mulberry32, pickWords } from "./prng.ts"
import type { Scenario } from "./args.ts"

export type Role = "user" | "assistant"
export type Msg = { id: number; role: Role; text: string; time: string }
export type Step = { id: number; ok: boolean; kind: string; detail: string }

const fmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
const now = () => fmt.format(new Date())

const KINDS = ["Read", "Edit", "Bash", "Grep", "Test", "Write"]
const FILES = ["src/auth/session.ts", "src/oauth/callback.ts", "docs/plano.md", "test/e2e/login.test.ts", "package.json", "src/rota/usuário.ts"]

// Armazenamento externo (fora do React): o gerador de eventos falso escreve aqui e a interface assina.
export class Store {
  private rnd = mulberry32(42)
  private listeners = new Set<() => void>()
  messages: Msg[] = []
  steps: Step[] = []
  private nextId = 1
  private target = 0 // tamanho-alvo (20 a 400) da mensagem do assistente em curso
  private ticking = false
  chunks = 0
  streamDone = false

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  private emit() {
    for (const l of this.listeners) l()
  }
  getMessages = () => this.messages
  getSteps = () => this.steps
  getChunks = () => this.chunks
  getStreamDone = () => this.streamDone

  private newTarget() {
    return 20 + Math.floor(this.rnd() * 381) // 20..400
  }
  private makeText(len: number): string {
    let t = pickWords(this.rnd, 1 + Math.floor(this.rnd() * 6))
    while (t.length < len) t += " " + pickWords(this.rnd, 1 + Math.floor(this.rnd() * 6))
    return t.slice(0, len).trimEnd()
  }
  private makeStep(): Step {
    const kind = KINDS[Math.floor(this.rnd() * KINDS.length)]!
    const file = FILES[Math.floor(this.rnd() * FILES.length)]!
    return { id: this.steps.length + 1, ok: this.rnd() > 0.08, kind, detail: file }
  }

  seedHistory(messages: number, steps: number) {
    const msgs: Msg[] = []
    for (let i = 0; i < messages; i++) {
      msgs.push({ id: this.nextId++, role: i % 2 === 0 ? "user" : "assistant", text: this.makeText(this.newTarget()), time: "09:12" })
    }
    this.messages = msgs
    for (let i = 0; i < steps; i++) this.steps.push(this.makeStep())
  }

  addUser(text: string) {
    this.messages = [...this.messages, { id: this.nextId++, role: "user", text, time: now() }]
    this.emit()
  }

  // Um pedaço = 1 a 6 palavras. A mensagem do assistente fica aberta até chegar ao tamanho-alvo (20 a 400
  // caracteres); ao fechar, o pedaço seguinte abre outra. O limite de 400 vale também para o último pedaço.
  private tick() {
    let chunk = pickWords(this.rnd, 1 + Math.floor(this.rnd() * 6))
    const last = this.messages[this.messages.length - 1]
    if (this.ticking && last && last.role === "assistant") {
      let text = last.text + " " + chunk
      while (text.length > 400 && chunk.includes(" ")) {
        chunk = chunk.slice(0, chunk.lastIndexOf(" "))
        text = last.text + " " + chunk
      }
      if (text.length > 400) text = last.text
      this.messages = [...this.messages.slice(0, -1), { ...last, text }]
      if (text.length >= this.target) this.ticking = false
    } else {
      this.target = this.newTarget()
      this.messages = [...this.messages, { id: this.nextId++, role: "assistant", text: chunk, time: now() }]
      this.ticking = chunk.length < this.target
      if (this.messages.length % 8 === 0) this.steps = [...this.steps, this.makeStep()]
    }
    this.chunks++
  }

  start(sc: Scenario) {
    if (sc.kind === "history") {
      this.seedHistory(sc.messages, sc.steps)
      return
    }
    for (let i = 0; i < 20; i++) this.steps.push(this.makeStep())
    this.messages = [{ id: this.nextId++, role: "user", text: "Execute o fluxo de login OAuth e mostre o progresso.", time: now() }]
    if (sc.rate <= 0) return
    const t0 = performance.now()
    let emitted = 0
    const timer = setInterval(() => {
      const el = (performance.now() - t0) / 1000
      if (sc.duration > 0 && el >= sc.duration) {
        clearInterval(timer)
        this.streamDone = true
        this.emit()
        return
      }
      // recupera atrasos: emite o que já venceu desde o início
      const due = Math.floor(el * sc.rate)
      const n = Math.min(due - emitted, 10)
      for (let i = 0; i < n; i++) this.tick()
      emitted = n > 0 ? emitted + n : emitted
      if (due - emitted > 10) emitted = due // descarta atraso excessivo em vez de acumular
      if (n > 0) this.emit()
    }, Math.max(5, Math.floor(1000 / sc.rate)))
  }
}
