# 07. Assinaturas e termos de uso

**Aviso:** nada aqui foi confirmado em texto oficial dos provedores. As informações vêm de busca na web (fontes secundárias) feita em 2026-11-08. Antes de apostar a arquitetura, leia os termos atuais da Anthropic (Consumer Terms e Usage Policy), da OpenAI (Termos do ChatGPT e do Codex) e de cada plano usado.

## Resumo por provedor

| Provedor | Uso da assinatura fora do cliente oficial | Estado | Confiança |
|---|---|---|---|
| **Anthropic (Claude Free, Pro, Max)** | Proibido o uso de tokens OAuth de assinatura em produtos de terceiros, inclusive o Agent SDK. Termos atualizados em 2026-02-19/20; bloqueio em prática desde cerca de 2026-01-09. Permitido: chave de API, pacotes de uso extra ou o cliente oficial Claude Code. O OpenCode removeu o suporte à assinatura do Claude. | Restritivo | Média (fontes secundárias) |
| **OpenAI (ChatGPT)** | O Codex CLI oficial aceita login da assinatura. O OpenCode tem login do ChatGPT na documentação; plugins da comunidade usam OAuth do Codex; um relato de 2026-09-29 diz que a OpenAI está facilitando o uso. Algumas fontes chamam de zona cinzenta. | Aparentemente mais aberto | Baixa a média |
| **MiniMax (via OpenCode)** | Plano e saldo próprios; em 2026-11-08 o saldo estava zerado (`insufficient balance (1008)`). Termos não lidos. | Não verificado | Baixa |

## O que o desenho assume

- O Claude **só pelo binário oficial** (`claude -p`, `claude --bg`, stream-json). Isso é diferente de pegar o token OAuth e chamar a API de outro produto. Mesmo assim, **laço automatizado e contínuo** (recorrente, sem supervisão) sobre uma assinatura é o ponto **não confirmado**. Quanto mais automação, maior a chance de a conta ser sinalizada.
- O `claude setup-token` existe para ambientes sem navegador (como CI) e é passado por `CLAUDE_CODE_OAUTH_TOKEN` ao `claude` oficial. A ajuda do comando diz apenas "Set up a long-lived authentication token (requires Claude subscription)". A validade de 1 ano citada pelo dono **não foi confirmada**.
- Para o ChatGPT, o `codex login --with-access-token` aceita um token pelo stdin; a duração é desconhecida.
- O desenho deve permitir **trocar de executor** sem reescrever o núcleo: o risco de termos se mitiga mantendo Claude e Codex como adaptadores equivalentes.

## Perguntas para ler nos termos oficiais

1. A Anthropic permite chamar `claude -p` em laço contínuo e agendado com uma assinatura Pro ou Max? Há limite de uso automatizado ou de simultaneidade?
2. O `setup-token` pode ser usado em máquinas diferentes ou em várias sessões simultâneas?
3. A OpenAI permite que um programa de terceiros dispare o Codex CLI (`exec`, `app-server`) com o login ChatGPT? E ferramentas como o OpenCode usarem o login?
4. Há restrição a várias contas pessoais do mesmo dono usadas em revezamento por cota? (Risco de ser lido como contornar limites.)
5. Os planos de outros provedores (MiniMax etc.) permitem uso programático por assinatura?

## Multi-conta: um alerta

Usar **várias assinaturas do mesmo provedor para somar cota** pode ser tratado como contornar limites de uso. A conversa tratou multi-conta como **contas de provedores diferentes** (Anthropic, ChatGPT, MiniMax) e eventualmente contas distintas do mesmo dono em uso legítimo (pessoal e trabalho). Releia os termos antes de balancear entre contas do mesmo provedor.
