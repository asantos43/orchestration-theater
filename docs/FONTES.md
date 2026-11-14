# Fontes

O arquivo tem três blocos:
1. **Fontes da arquitetura v0.10**, consultadas pelos autores da arquitetura em 2026-11-13 (§14). **Não foram reabertas nesta revisão do repositório.**
2. **Links de buscas na web de 2026-11-08.**
3. **Verificação local** de 2026-11-08.

## 1. Fontes da arquitetura (consultadas em 2026-11-13, segundo a arquitetura §14)

São quase todas documentação oficial ou repositórios dos próprios projetos:
- **ACP:** agentclientprotocol.com (session-setup, session-config-options, clients); github.com/agentclientprotocol (typescript-sdk, claude-agent-acp, codex-acp).
- **MCP SDK v2:** ts.sdk.modelcontextprotocol.io; blog.modelcontextprotocol.io.
- **Claude Code:** code.claude.com/docs (permissions, cli-reference, sandboxing, statusline, authentication, env-vars, monitoring-usage, **legal-and-compliance**, llm-gateway, agent-sdk/subagents). A página legal-and-compliance é a base dos termos citados em [07](07-ASSINATURAS-E-TERMOS.md).
- **Codex:** learn.chatgpt.com/docs (app-server, config-advanced, auth, windows-sandbox).
- **OpenCode:** opencode.ai/docs (acp, permissions, server, sdk, troubleshooting).
- **MiniMax:** platform.minimax.io/docs (coding-plan, token-plan/faq).
- **XState:** stately.ai/docs/persistence.
- **Sandbox:** github.com/anthropic-experimental/sandbox-runtime.
- **ATIF:** github.com/harbor-framework/harbor (rfcs/0001-trajectory-format.md); docs.harborframework.com.
- **OTel GenAI:** opentelemetry.io/docs/specs/semconv/gen-ai.
- **Reaproveitamento:** github.com/generalaction/emdash, openclaw/acpx, stablyai/orca, ryoppippi/ccusage, steipete/CodexBar; assistant-ui.com; ui.shadcn.com; github.com/vercel/ai-elements; docs.1mcp.app; github.com/ohadravid/win32job-rs; ai.google.dev/gemma (Gemma 4).

## 2. Buscas na web (2026-11-08)

Links retornados por buscas na web em 2026-11-08. **A maioria é secundária** (blogs, agregadores, documentação de terceiros). Nenhum é texto oficial dos termos dos provedores, salvo a ajuda da OpenAI indicada, que **não foi aberta**. Leia as fontes oficiais antes de decidir. Onde estes links divergem do bloco 1 (por exemplo, sobre o uso de assinatura do Claude), ver a discussão em [07](07-ASSINATURAS-E-TERMOS.md).

### Termos e uso de assinaturas (Anthropic)

- The Register, AlternativeTo, Gigazine, Let's Data Science, um post de 2026-04-07 e um artigo do Zenn, citados nas buscas sobre o bloqueio de tokens OAuth de assinatura em produtos de terceiros. Os endereços exatos não ficaram guardados nesta conversa; refazer a busca "Anthropic OAuth token subscription third-party OpenCode" para recuperá-los.
- [Claude Code Subscriptions, Bans & Codex Comparison](https://agentic-ai-handbook.pages.dev/06-subscriptions-and-bans)
- [Anthropic's Model Lockdown vs OpenAI's OpenCode Integration](https://www.besthub.dev/articles/anthropic-s-model-lockdown-vs-openai-s-opencode-integration-what-it-means-for-developers-74830a2c24d8)

### Termos e uso de assinaturas (OpenAI e Codex)

- [ChatGPT subscription OAuth (yage.ai, 2026-10-13)](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html)
- [Jump Ship in Minutes: Codex OAuth Now Works in OpenCode](https://blog.devgenius.io/jump-ship-in-minutes-codex-oauth-now-works-in-opencode-d2708c32f571)
- [OpenHands SDK: LLM subscriptions](https://docs.openhands.dev/sdk/guides/llm-subscriptions)
- [OpenAI help: Codex sign-in](https://help.openai.com/articles/11369540)

### ATIF (Agent Trajectory Interchange Format)

- [Harbor: loading trajectories](https://docs.harborframework.com/core-concepts/jobs/loading-trajectories)
- [Harbor: load trajectory](https://www.harborframework.com/docs/run-jobs/load-trajectory)
- [Harbor ATIF (documentação espelhada)](https://mintlify.wiki/harbor-framework/harbor/core-concepts/agents/atif)
- [vtcode-exec-events, implementação da 1.4 (aponta para a RFC do Harbor)](https://docs.rs/crate/vtcode-exec-events/0.99.1/source/src/atif.rs)
- A RFC de origem, `docs/rfcs/0001-trajectory-format.md`. Em 2026-11-08 ela foi atribuída ao repositório `laude-institute/harbor`; a arquitetura (2026-11-13) cita `harbor-framework/harbor` e a versão ATIF-v1.8. Não foi aberta.
- As páginas da NVIDIA (NeMo Relay) descrevem um exportador próprio de ATIF, não a especificação do Harbor.

## 3. Verificação local

`claude --help`, `claude setup-token --help`, `claude auth --help`, `codex --help`, `codex app-server --help`, `codex exec --help`, `codex login --help` e `codex login status`, rodados em 2026-11-08 (Claude Code 2.1.319 e codex-cli 0.167.0). Resumo em [08](08-CLIENTES-CLI-REFERENCIA.md).
