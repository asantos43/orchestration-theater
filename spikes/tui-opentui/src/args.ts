export type Scenario =
  | { kind: "stream"; rate: number; duration: number }
  | { kind: "history"; messages: number; steps: number }

function num(v: string | undefined, def: number, name: string): number {
  if (v === undefined) return def
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) {
    console.error(`valor inválido para ${name}: ${v}`)
    process.exit(2)
  }
  return n
}

// Aceita `--chave valor` e `--chave=valor`. O `--` solto (de `bun run start -- ...`) é ignorado.
export function parseArgs(argv: string[]): Scenario {
  const opts = new Map<string, string>()
  const rest = argv.filter((a) => a !== "--")
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq > 0) opts.set(a.slice(2, eq), a.slice(eq + 1))
    else opts.set(a.slice(2), rest[i + 1] ?? "")
    if (eq < 0) i++
  }
  const kind = opts.get("scenario") ?? "stream"
  if (kind === "history") {
    return {
      kind: "history",
      messages: num(opts.get("messages"), 5000, "--messages"),
      steps: num(opts.get("steps"), 1000, "--steps"),
    }
  }
  if (kind !== "stream") {
    console.error(`cenário desconhecido: ${kind} (use stream ou history)`)
    process.exit(2)
  }
  return {
    kind: "stream",
    rate: num(opts.get("rate"), 50, "--rate"),
    duration: num(opts.get("duration"), 60, "--duration"), // 0 = sem limite
  }
}
