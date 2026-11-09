# 02. Núcleo comum às duas arquiteturas

As duas arquiteturas em comparação são **com contêiner** ([03](03-ARQUITETURA-1-COM-CONTEINERES.md)) e **sem contêiner** ([04](04-ARQUITETURA-2-SEM-CONTEINERES.md)). Elas diferem **só no runner** (onde e como o agente executor e as verificações rodam). Todo o resto é este núcleo, que é um **cliente fino próprio** sobre os CLIs oficiais.

A opção de **não** construir o núcleo e continuar com o Claude Code como Diretor mais o `okit` é outro eixo de decisão e está em [06](06-ALTERNATIVA-HARNESS-EXISTENTE.md).

## Ideia

Um **núcleo seu** (daemon local com API, estado durável, política, agendador, dashboards e app de desktop) que **encapsula os CLIs oficiais** (Claude Code, Codex, OpenCode) de duas maneiras:

1. **Como pontos de modelo "só decisão"** para o orquestrador: o núcleo chama `claude -p` ou `codex exec` com as ferramentas desligadas e saída JSON estruturada; o núcleo valida a resposta e é ele quem executa a ação. O orquestrador **não sai do papel porque não tem nenhuma ferramenta**.
2. **Como executores**: o núcleo lança o CLI numa worktree isolada, com ferramentas e permissões definidas por ele, e acompanha os eventos.

Nada de chave de API: cada CLI usa o login da assinatura da sua conta (diretório de configuração separado por conta).

## Módulos

| Módulo | Responsabilidade |
|---|---|
| **Núcleo (daemon)** | Estado durável (SQLite), máquina de estados do fluxo (Produtor, Autor, Revisor, Roteirista, Diretor, Atores, Crítico), fila, política, API local (HTTP e WebSocket ou SSE, com token, no mesmo padrão do `okit-plugin config ui`) |
| **Adaptadores de cliente** | Um por CLI. Lançam, leem eventos, retomam sessões e convertem para o **formato interno de eventos**. Claude: `-p` com stream-json, `--permission-prompts host`, `--bg`. Codex: `exec --json` (primeiro) e `app-server` (depois). OpenCode: o CLI dele |
| **Broker de contas** | Por conta: cliente, estado de login (`ok`, `expira-em`, `precisa-login`), cota, tokens no cofre do sistema. Escolhe a conta a cada lançamento, nunca cruza sessão entre clientes, dispara o relogin |
| **Orquestradores** | Um por projeto. Cada chamada é uma decisão estruturada com o modelo e esforço mais baratos que passem na verificação |
| **Runner** | **A única peça que muda entre as arquiteturas.** Cria o ambiente do agente, roda o executor e roda **testes, compilação e mutações fora do sandbox do cliente**. Ver a interface abaixo |
| **Ferramentas próprias (MCP)** | Web (com lista de domínios, taxa e registro), e-mail (envio só pelo núcleo), arquivos e outras. Valem para qualquer cliente |
| **Agendador** | Tarefas recorrentes e agendadas, política de execução perdida, janela de cota |
| **Telemetria** | Log de eventos que só cresce, custo e cota por conta, e geração de **ATIF** |
| **Clientes** | Dashboard web, app de desktop (Electron ou Tauri), CLI. Todos sobre a mesma API |
| **Plugins** | Processos externos com manifesto; MCP como protocolo de ferramentas |

## Interface do runner (proposta)

O núcleo só conhece esta interface; cada arquitetura a implementa de um jeito.

| Operação | O que faz |
|---|---|
| `preparar(tarefa)` | Cria a worktree, o ambiente (variáveis mínimas, `HOME` e diretórios temporários próprios, configuração da conta) e os limites (tempo, memória, processos) |
| `executar(comando, opções)` | Roda um comando ou o CLI do agente no ambiente, devolvendo fluxo de saída, código de saída e uso de recursos |
| `rede(política)` | Aplica a política de rede (liberada, só lista de domínios, sem rede) |
| `capacidades()` | Diz o que o runner garante: isolamento de arquivos, de rede, de portas, limite de recursos, reprodutibilidade |
| `encerrar()` | Mata a árvore de processos, recolhe artefatos e limpa |

`capacidades()` deixa a **política do núcleo** escolher o runner por tarefa (por exemplo: leitura da web e código não confiável pedem isolamento forte; um build do macOS só roda em runner nativo).

## Desenho

```
 Dashboard web · App desktop (Win/macOS/Linux) · CLI
                      │  API local (token)
                      ▼
   ┌────────────────────── NÚCLEO (daemon, serviço do sistema) ──────────────────────┐
   │  estado (SQLite) · fluxo · política · fila · agendador · broker de contas         │
   │  log de eventos ─► telemetria ─► ATIF                                             │
   └──────┬──────────────────────┬──────────────────────────┬─────────────────────────┘
          │ decisões (sem ferram.)│ lança executores        │ ferramentas próprias (MCP)
          ▼                       ▼                         ▼
   Orquestrador (por projeto)  Adaptadores ──► claude · codex · opencode      web · e-mail · ...
   claude -p / codex exec              │
   modelo barato, sem tools            ▼
                                  RUNNER  ◄── arquitetura 1: contêiner · arquitetura 2: nativo
                              (worktree, testes, mutações)
```

## O orquestrador "só decisão"

1. O núcleo monta o estado (resumo curto, handoff, o que falta) e chama o CLI barato com um prompt fixo.
2. As ferramentas do cliente ficam desligadas (`--disallowedTools` no Claude; política do Codex) e a resposta é JSON validado por esquema (`--json-schema` no Claude, `--output-schema` no Codex).
3. O núcleo valida a decisão (por exemplo: lançar executor X no passo Y, aprovar, escalar) e a executa.
4. A caixa de conversa do dashboard funciona igual: cada mensagem vira uma chamada de decisão com o estado do projeto anexado.

**Limites do modelo**: cada chamada carrega o prompt de sistema do cliente (mais cota que uma chamada enxuta de API), não há streaming contínuo entre turnos e o formato de saída muda com a versão dos CLIs (fixar versões e ter testes de contrato).

## Opção de processo vivo

- **Claude**: `claude -p --input-format stream-json --output-format stream-json --session-id <uuid>` mantido aberto; mensagens como linhas JSON no stdin. `--permission-prompts host` ou `--permission-prompt-tool` mandam cada pedido de permissão ao núcleo, que decide pela política.
- **Codex**: `codex app-server` (experimental) com daemon, socket de controle e esquema do protocolo gerável; processo vivo e aprovações por requisição. O caminho estável é `codex exec --json` com `resume`, um processo por turno.
- Recomendação: começar pelo `exec --json` e deixar o `app-server` como segunda implementação da mesma interface.

## Contas e relogin

- Uma conta por diretório (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- `claude auth status` e `codex login status` alimentam o estado de login; falha de autenticação põe a conta em `precisa-login` e pausa a fila dela, enquanto o broker passa o trabalho a outra conta elegível.
- `claude setup-token` gera um token de longa duração (o dono cita 1 ano; **não confirmado**), passado por `CLAUDE_CODE_OAUTH_TOKEN` ao `claude` oficial; serve para executores sem navegador. O Codex tem `--with-access-token` (duração desconhecida).
- Tokens ficam no cofre do sistema (Keychain, Credential Manager, libsecret) e são redigidos em logs.

## Prós e contras do núcleo próprio (valem para as duas arquiteturas)

**Prós**: papel do orquestrador garantido por construção; controle total de permissões, contas, cota e ferramentas (resolve P3, P4, P5 de [01](01-CONTEXTO-E-PROBLEMAS.md)); verificações sob controle do Runner (resolve P2); interface própria (P10); estado durável em banco e chamadas curtas (P9); multi-projeto com um plano de controle; neutro quanto ao fornecedor; telemetria e ATIF nativos; tarefas gerais e agendadas como cidadãs de primeira classe.

**Contras**: esforço alto (é um produto); risco de termos de uso, sobretudo do Claude em automação contínua ([07](07-ASSINATURAS-E-TERMOS.md)); formatos dos CLIs que mudam entre versões (fixar versões, testes de contrato); peso do prompt de sistema por chamada; `exec` do Codex é um processo por turno e o `app-server` é experimental; superfície de segurança maior (internet, e-mail, tokens, API local, plugins); duplica parte do que o `okit` já faz; custo de oportunidade frente aos produtos em andamento.

## Fases sugeridas (independentes do runner até a Fase 3)

1. **Fase 0, validação barata** (dias): script que chama `codex exec --output-schema` e `claude -p --json-schema` como "decisão sem ferramentas", mede o consumo de cota por chamada e confirma o formato dos eventos. Ler os termos atuais da Anthropic e da OpenAI. **Aqui também testar o runner**: rodar a suíte de um projeto real (okit-plugin) no cenário nativo e no de contêiner, e comparar.
2. **Fase 1, núcleo mínimo**: daemon com SQLite, log de eventos, adaptador do Codex (`exec --json`), orquestrador sem ferramentas, interface do runner com **uma** implementação, CLI como único cliente.
3. **Fase 2, contas e cota**: broker de contas, leitura de cota, relogin, adaptador do Claude (`-p`, `--permission-prompts host`), cofre de segredos.
4. **Fase 3, verificação**: testes e mutações pelo runner, crítico, fluxo completo com PR e merge, absorvendo o que o `okit` faz.
5. **Fase 4, interface**: API estável, dashboard web com trajetória ao vivo, geração de ATIF.
6. **Fase 5, tarefas gerais**: agendador, ferramentas web e e-mail próprias, fluxos paralelos, o exemplo das manchetes.
7. **Fase 6, desktop e plugins**: app Electron ou Tauri, serviço do sistema nos três sistemas, plugins por manifesto, OpenCode como terceiro adaptador, e a **segunda implementação do runner**, se a decisão for oferecer as duas.
