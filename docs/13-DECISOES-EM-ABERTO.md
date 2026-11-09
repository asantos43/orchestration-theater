# 13. Decisões em aberto

Estado das perguntas. **Nada está decidido.** Ao decidir, mude o estado, registre a data e o motivo. A recomendação é só a opinião da conversa de 2026-11-08.

| # | Pergunta | Opções | Recomendação da conversa | Estado |
|---|---|---|---|---|
| Q1 | **Arquitetura do runner: com contêiner ou sem contêiner?** | 1 (contêiner), 2 (nativo), híbrido com runner trocável | Híbrido: interface de runner, nativo por padrão, contêiner opcional; medir na Fase 0 ([05](05-COMPARACAO-E-CRITERIOS.md)) | Aberta |
| Q2 | **O desktop para Windows e macOS é objetivo de primeira linha?** (pesa contra o contêiner) | Sim; só Linux por ora | Sim, segundo o dono; confirmar o peso | Aberta |
| Q3 | **Construir o núcleo próprio ou continuar com o Claude Code + `okit`?** | Núcleo próprio ([02](02-NUCLEO-COMUM.md)); continuar com o harness existente endurecido ([06](06-ALTERNATIVA-HARNESS-EXISTENTE.md)); os dois no tempo | Os dois no tempo: endurecer o que existe agora e medir na Fase 0 antes de construir | Aberta |
| Q4 | **Termos de uso**: automação contínua de `claude -p` sobre assinatura é aceitável? | Ler os termos; aceitar o risco; usar só Codex e outros | Ler os termos primeiro; manter troca de executor ([07](07-ASSINATURAS-E-TERMOS.md)) | Aberta |
| Q5 | **Linguagem e processo do núcleo** | TypeScript (Node) ou outra | TypeScript: tipos compartilhados com dashboard e desktop; experiência prévia (Folder Browser, okit-plugin) | Aberta |
| Q6 | **App de desktop** | Electron ou Tauri | Electron (experiência prévia); Tauri é menor mas exige Rust | Aberta |
| Q7 | **Orquestrador: chamada por turno ou processo vivo** | `claude -p`/`codex exec` por chamada; stream-json vivo; app-server | Por chamada no começo; processo vivo depois, atrás da mesma interface ([02](02-NUCLEO-COMUM.md)) | Aberta |
| Q8 | **Adaptador do Codex** | `exec --json` ou `app-server` (experimental) | `exec --json` primeiro; `app-server` como segunda implementação | Aberta |
| Q9 | **Isolamento no cenário nativo** | Política do núcleo; usuário do sistema dedicado; sandbox do cliente; runner de contêiner opcional para tarefas de risco | Política mais usuário dedicado se viável; medir na Fase 0 ([04](04-ARQUITETURA-2-SEM-CONTEINERES.md)) | Aberta |
| Q10 | **Runtime de contêiner no cenário com contêiner** | Podman (o dono já usa), Docker Desktop, Colima, WSL2 | Podman (livre, rootless, já em uso) ([03](03-ARQUITETURA-1-COM-CONTEINERES.md)) | Aberta |
| Q11 | **Versão do ATIF** e campos de extensão | 1.7 (atual segundo fontes) ou outra | Ler a RFC e fixar a versão ([11](11-TELEMETRIA-E-ATIF.md)) | Aberta |
| Q12 | **Relação com o `okit`** | Migrar a lógica ao núcleo, absorver, conviver | `okit` como primeiro cliente; migrar aos poucos | Aberta |
| Q13 | **Onde mora o estado** | SQLite local; arquivos; outro | SQLite local com log de eventos append-only | Aberta |
| Q14 | **Meta de custo da orquestração** | Um percentual da cota por demanda a definir depois da Fase 0 | Medir antes de fixar | Aberta |
| Q15 | **Multi-conta do mesmo provedor** | Permitir ou restringir | Restringir até ler os termos ([07](07-ASSINATURAS-E-TERMOS.md)) | Aberta |
| Q16 | **Acesso remoto ao núcleo** | Só local; túnel (Tailscale, Cloudflare Tunnel); Remote Control do cliente | Só local no começo; túnel depois | Aberta |
| Q17 | **Modelo do orquestrador** | Haiku, Luna ou outro; esforço baixo ou médio | O mais barato que passe nos critérios de decisão; medir | Aberta |
| Q18 | **Plugins** | Processos externos com manifesto e MCP; outro | Processos externos com manifesto | Aberta |
| Q19 | **Nome definitivo do produto** | `multi-agent-orchestration` é o nome do repositório de desenho | Decidir ao escolher a arquitetura | Aberta |

## Ideias registradas, sem prioridade

- Medir a **qualidade por executor** (erro e retrabalho) com a telemetria; era um desejo anterior do dono, adiado até os ajustes do kit.
- Uma etapa `init` que levanta assinaturas, modelos, capacidades e limites paralelos de cada máquina (ideia anterior do kit).
- Os **seis agentes em paralelo** do dono (2 por assinatura, 3 assinaturas) como limite de simultaneidade padrão do núcleo.

## Próximas ações sugeridas

1. Ler os termos oficiais da Anthropic e da OpenAI (Q4, Q15).
2. Fase 0: script de decisão sem ferramentas, com medição de cota e dos formatos de evento, **e a comparação do runner** (suíte do `okit-plugin` nativa e em contêiner, seis agentes em paralelo) ([02](02-NUCLEO-COMUM.md), [05](05-COMPARACAO-E-CRITERIOS.md)), quando as cotas voltarem (Anthropic em cerca de 16 horas e ChatGPT em cerca de 3 dias, a partir de 2026-11-08).
3. Decidir Q1 e Q3 com esses números.
