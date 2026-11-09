# Fontes

Links retornados por buscas na web em 2026-11-08. **A maioria é secundária** (blogs, agregadores, documentação de terceiros). Nenhum é texto oficial dos termos dos provedores, salvo a ajuda da OpenAI indicada, que **não foi aberta**. Leia as fontes oficiais antes de decidir.

## Termos e uso de assinaturas (Anthropic)

- The Register, AlternativeTo, Gigazine, Let's Data Science, um post de 2026-04-07 e um artigo do Zenn, citados nas buscas sobre o bloqueio de tokens OAuth de assinatura em produtos de terceiros. Os endereços exatos não ficaram guardados nesta conversa; refazer a busca "Anthropic OAuth token subscription third-party OpenCode" para recuperá-los.
- [Claude Code Subscriptions, Bans & Codex Comparison](https://agentic-ai-handbook.pages.dev/06-subscriptions-and-bans)
- [Anthropic's Model Lockdown vs OpenAI's OpenCode Integration](https://www.besthub.dev/articles/anthropic-s-model-lockdown-vs-openai-s-opencode-integration-what-it-means-for-developers-74830a2c24d8)

## Termos e uso de assinaturas (OpenAI e Codex)

- [ChatGPT subscription OAuth (yage.ai, 2026-10-13)](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html)
- [Jump Ship in Minutes: Codex OAuth Now Works in OpenCode](https://blog.devgenius.io/jump-ship-in-minutes-codex-oauth-now-works-in-opencode-d2708c32f571)
- [OpenHands SDK: LLM subscriptions](https://docs.openhands.dev/sdk/guides/llm-subscriptions)
- [OpenAI help: Codex sign-in](https://help.openai.com/articles/11369540)

## ATIF (Agent Trajectory Interchange Format)

- [Harbor: loading trajectories](https://docs.harborframework.com/core-concepts/jobs/loading-trajectories)
- [Harbor: load trajectory](https://www.harborframework.com/docs/run-jobs/load-trajectory)
- [Harbor ATIF (documentação espelhada)](https://mintlify.wiki/harbor-framework/harbor/core-concepts/agents/atif)
- [vtcode-exec-events, implementação da 1.4 (aponta para a RFC do Harbor)](https://docs.rs/crate/vtcode-exec-events/0.99.1/source/src/atif.rs)
- A RFC de origem, no repositório `laude-institute/harbor`: `docs/rfcs/0001-trajectory-format.md` (não aberta).
- As páginas da NVIDIA (NeMo Relay) descrevem um exportador próprio de ATIF, não a especificação do Harbor.

## Verificação local

`claude --help`, `claude setup-token --help`, `claude auth --help`, `codex --help`, `codex app-server --help`, `codex exec --help`, `codex login --help` e `codex login status`, rodados em 2026-11-08 (Claude Code 2.1.319 e codex-cli 0.167.0). Resumo em [08](08-CLIENTES-CLI-REFERENCIA.md).
