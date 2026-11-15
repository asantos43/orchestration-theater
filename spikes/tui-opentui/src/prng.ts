// PRNG determinístico (mulberry32) e vocabulário em português com acento.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const WORDS = [
  "ação", "além", "então", "também", "já", "não", "é", "você", "até", "são",
  "código", "função", "módulo", "sessão", "autenticação", "configuração", "variável", "método",
  "serviço", "orquestração", "migração", "revisão", "decisão", "execução", "integração", "versão",
  "teste", "falhou", "passou", "arquivo", "pasta", "projeto", "tarefa", "peça", "plano", "demanda",
  "crítico", "próximo", "último", "padrão", "rápido", "histórico", "trajetória", "painel", "lateral",
  "usuário", "senha", "credencial", "token", "cota", "assinatura", "agente", "executor", "ator",
  "revisor", "autor", "produtor", "diretor", "mensagem", "resposta", "pergunta", "dúvida", "opção",
  "está", "estão", "foi", "serão", "precisa", "deve", "pode", "vamos", "fazer", "conferir", "ajustar",
  "criar", "remover", "atualizar", "validar", "registrar", "começar", "terminar", "continuar",
  "com", "sem", "para", "por", "sobre", "entre", "depois", "antes", "agora", "ainda", "sempre",
  "o", "a", "os", "as", "um", "uma", "de", "da", "do", "em", "no", "na", "que", "se", "e", "ou",
  "máquina", "memória", "gráfico", "terminal", "janela", "largura", "altura", "rolagem", "borda",
]

export function pickWords(rnd: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]!)
  return out.join(" ")
}
