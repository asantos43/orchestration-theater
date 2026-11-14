# 07. Assinaturas e termos de uso

**Aviso.** Termos de uso mudam. Este documento junta duas leituras:
- **2026-11-13**: a arquitetura v0.10 (§3, §11 e §14) cita a documentação oficial do Claude Code (*legal-and-compliance*, *authentication*) e da OpenAI (*auth*), consultadas nessa data. **Nesta revisão do repositório, essas páginas não foram reabertas**: a informação é de segunda mão, a partir da arquitetura.
- **2026-11-08**: busca na web, só em fontes secundárias ([FONTES](FONTES.md)).

Antes de distribuir o produto, ou de aumentar a automação, releia os termos atuais de cada provedor.

## Premissa da arquitetura (§3)

- **A assinatura é usada só pelo cliente oficial, sem tocar no token.** O OTheater nunca lê, copia nem reaproveita tokens OAuth. Ele dispara o login oficial num diretório de perfil isolado e executa o CLI oficial.
- **O sistema aceita assinaturas e chaves de API.** A chave fica no cofre do sistema operacional e é injetada só no processo do Executor ([09](09-ISOLAMENTO-E-SEGURANCA.md)).

## Resumo por provedor

| Provedor | O que se sabe | Fonte e data | Confiança |
|---|---|---|---|
| **Anthropic (Claude Pro/Max)** | O login OAuth é para o "uso comum do Claude Code e de outros aplicativos nativos da Anthropic". Quem desenvolve **produtos**, inclusive com o Agent SDK, precisa usar **chave de API**: não pode oferecer login do Claude.ai, encaminhar requisições pelas credenciais de assinatura em nome de usuários, nem coletar ou intermediar esses tokens. É permitido que um usuário final entre com a própria assinatura no **binário do Claude Code sem modificação**. | Arquitetura §3, citando code.claude.com/docs (legal-and-compliance), 2026-11-13. Não reaberto nesta revisão | Média (documentação oficial, mas lida por intermédio) |
| **Anthropic (contexto anterior)** | Bloqueio do uso de tokens OAuth de assinatura em produtos de terceiros, em prática desde cerca de 2026-01-09. Termos atualizados em 2026-02-19/20. O OpenCode removeu o suporte à assinatura do Claude. | Busca na web, 2026-11-08 | Média (fontes secundárias) |
| **OpenAI (ChatGPT / Codex)** | O Codex CLI oficial aceita login da assinatura. A documentação recomenda chave de API para automação e pede tratar o `auth.json` como senha. Há relatos de que o uso do login ChatGPT em ferramentas de terceiros é permitido por parceria **[a confirmar]**. | Arquitetura §3 (learn.chatgpt.com/docs, auth), 2026-11-13; busca na web, 2026-11-08 | Baixa a média |
| **MiniMax (Token Plan)** | Plano próprio, com janelas de 5 h e semanal (endpoint `/v1/token_plan/remains`). Há um endpoint oficial compatível com a Anthropic (`https://api.minimax.io/anthropic`). Os termos sobre uso programático não foram lidos. Em 2026-11-08, o saldo estava zerado (`insufficient balance (1008)`). | Arquitetura §5.6 e §5.7 (platform.minimax.io/docs), 2026-11-13; observação local, 2026-11-08 | Baixa |

## Consequência para o OTheater (risco R1)

- O **uso pessoal**, em que cada pessoa roda o daemon com os próprios logins acionando o CLI oficial, **se encaixa na permissão**, segundo a leitura da arquitetura.
- **Distribuir como produto** para terceiros com assinatura Claude **exige confirmação com a Anthropic**. Até lá, o modo produto usa chave de API para o Claude. Isso é a decisão N2 em [13](13-DECISOES-EM-ABERTO.md).
- **Ponto sensível:** o adaptador `claude-agent-acp` usa o **Agent SDK**. A própria arquitetura registra isso no R1 ("inclusive com Agent SDK, que o `claude-agent-acp` usa"). Ainda não foi confirmado se acionar o Claude Code por esse adaptador conta como o "binário sem modificação" permitido ao usuário final. A Fase 0 inclui pedir essa confirmação à Anthropic.
- **Saída se a resposta for negativa** (não confirmada como suficiente):
  - o modo headless do binário oficial (`claude -p --output-format stream-json`, §5.2);
  - chave de API para o Claude;
  - Executores de outros provedores.

  A troca de Executor sem reescrever o núcleo continua sendo a mitigação geral.

## Perguntas a responder nos termos oficiais

1. O uso pessoal do Claude Code por meio do `claude-agent-acp` (Agent SDK), com o login do próprio usuário, está coberto pela permissão ao usuário final?
2. A automação contínua e agendada (§5.15) sobre uma assinatura Pro ou Max tem limite de uso automatizado ou de simultaneidade?
3. A OpenAI permite que um programa de terceiros dispare o Codex (`codex-acp`, `app-server`) com o login ChatGPT?
4. Há restrição a várias contas pessoais do mesmo dono usadas em revezamento por cota? (Risco de isso ser lido como contornar limites.)
5. Os planos de outros provedores (MiniMax etc.) permitem uso programático por assinatura?
6. O `claude setup-token` (token de longa duração, "requires Claude subscription", segundo `claude setup-token --help`, verificado localmente em 2026-11-08) pode ser usado em várias sessões simultâneas? A validade de 1 ano citada pelo dono **não foi confirmada**. A arquitetura não usa o `setup-token`: o login é feito no diretório de cada perfil.

## Multi-conta: um alerta

Usar **várias assinaturas do mesmo provedor para somar cota** pode ser tratado como contornar limites de uso. A arquitetura (§3) diz para conferir os termos de cada provedor e aponta os **planos de time/empresa com vários assentos** como o caminho limpo. Até ler os termos, restrinja o balanceamento entre contas do mesmo provedor (decisão Q15 em [13](13-DECISOES-EM-ABERTO.md)).
