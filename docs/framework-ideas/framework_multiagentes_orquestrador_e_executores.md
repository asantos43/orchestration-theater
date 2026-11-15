# Definições de Entidades: Orquestrador e Executores

> **Nota (2026-11-14).** Este texto é o registro das ideias iniciais do dono e não foi reescrito. A referência é a [arquitetura](arquitetura.md) v0.32 e o [fluxo da peça](fluxo-da-peca.md). Quando divergirem, vale a arquitetura.
>
> O que mudou:
> - Executor é cliente + perfil + modelo + esforço, com nome `<modelo>-<esforço>@<cliente>/<perfil>` (§5.2, §5.7 e §13).
> - Todos os papéis, inclusive o Diretor e o Consultor, têm uma lista de Executores com fallback. A seleção usa prioridade e cota, com assinaturas e chaves de API, estas com teto de gasto (§5.6 e §5.7).
> - O estado fica no daemon, que roda como serviço de logon, e não na sessão principal do cliente (P4 e §5.1).
> - O Orquestrador é o Diretor: uma sessão ACP que o daemon abre. Quem abre os Executores é o daemon. Há failover do Diretor quando a cota ou o perfil falham (§4 e §5.4).
> - A interface com o Produtor é a TUI, depois a web, o desktop e o Android, todos sobre a API do daemon (P7 e §5.13).
> - O framework é o daemon com o servidor MCP filtrado por papel e as cascas. As extensões são plugins MCP fora do processo (§5.3, §5.14 e §5.18).
> - A contenção de escopo usa o filtro MCP e as permissões em três camadas (§5.8). Cada papel tem uma fronteira estreita (P13 e §5.4).
> - Os clientes ficam atrás da porta `ClientAdapter`. O Gemini CLI é um cliente opcional (§5.18 e §6.2).
> - As cotas incluem a contabilidade local do OpenCode e o fallback pelo erro de limite, pela porta `QuotaProbe` (§5.6 e §5.18).
> - O ATIF é o *Agent Trajectory Interchange Format* v1.8, com o bloco `extra.otheater` e a peça inteira como unidade (§5.11).

Este documento detalha as entidades responsáveis por operacionalizar o Framework de Controle Multiagentes, mapeando a arquitetura técnica aos papéis de produção teatral.

## 1. O Executor

O Executor é a unidade de trabalho modular do sistema. Ele é definido pela combinação de um **Modelo de IA + Esforço de um cliente** (como Claude Code, Codex ou OpenCode).

*   **Atribuições de Papel:** O Executor é flexível e pode assumir os papéis de **Autor** (planejamento), **Revisor** (validação de plano), **Roteirista** (divisão e sequenciamento de tarefas), **Ator** (execução especialista) e **Crítico** (avaliação de qualidade).
*   **Seleção Dinâmica:** O melhor tipo de Executor (qual modelo específico e configuração de cliente) será escolhido dependendo do papel que ele irá desempenhar, otimizando recursos e capacidades (ex: modelos de alto raciocínio para o Crítico, modelos rápidos e conteudistas para os Atores).
*   **Alocação e Cotas:** **A alocação de Executores dependerá estritamente da disponibilidade de cotas de cada assinatura.** O sistema deve gerenciar o consumo para garantir que as requisições não excedam os limites impostos pelos provedores (Claude, OpenAI, etc.).

## 2. O Orquestrador

O Orquestrador atua como o sistema nervoso central do framework. Tecnicamente, é um executor rodando na **sessão principal** do cliente escolhido (Claude Code, Codex ou OpenCode).

*   **Atribuições de Papel:** O Orquestrador assume o papel central de **Diretor** e serve como a **interface primária com o Produtor** (usuário final ou sistema gatilho).
*   **Ferramentas e Determinação:** Para garantir estabilidade e previsibilidade, o Orquestrador terá acesso a ferramentas que permitam executar o seu trabalho de forma **consistente e determinística**. Isso inclui o controle rigoroso do estado global, gestão de repositório de código (*worktrees/branches*), roteamento de tarefas e tratamento de exceções.
*   **Isolamento de Falhas:** Mantendo o papel de Orquestrador na sessão principal e delegando tarefas para sessões executoras independentes, o sistema garante que falhas, *timeouts* ou "alucinações" em uma tarefa específica não comprometam o fluxo global da demanda.

## 3. O Framework Multiagente: Abstração, Controle e Telemetria

O Framework Multiagente atua como a infraestrutura subjacente que viabiliza a orquestração teatral. Ele é composto por um conjunto coeso de *Skills, hooks, tools, scripts* e MCPs (Model Context Protocols), projetado para fornecer todas as ferramentas necessárias para o perfeito funcionamento do sistema.

### Abstração e Transparência
*   **Abstração de Chamadas:** O núcleo do framework abstrai todas as funcionalidades de execução. Ele garante que todos os Executores funcionem da mesma forma, independentemente do agente de IA que os aciona.
*   **Clientes Suportados:** Inicialmente, o framework permite o uso transparente dos clientes de CLI **Claude Code, Codex e OpenCode**. A arquitetura permite fácil expansão para novos agentes.
*   **Multiplataforma:** O núcleo do framework é projetado para ser multi-agente de IA, multi-projeto e compatível com todos os Sistemas Operacionais suportados pelos agentes de CLI utilizados.

### Consistência e Determinismo do Orquestrador
*   **Independência de Contexto:** Uma função vital do framework é garantir que o Orquestrador saiba sempre o que deve fazer, sem depender de seu próprio histórico de contexto ou memória. Isso protege o fluxo contra eventos de compressão de contexto ou reinicializações do cliente.
*   **Contenção de Escopo:** O framework força o Orquestrador a utilizar exclusivamente as ferramentas homologadas (evitando o uso de ferramentas fora do escopo). Essas ferramentas estritas garantem uma operação **consistente e determinística**, blindando o Orquestrador contra alucinações ou esquecimentos estruturais.

### Observabilidade e Gestão de Recursos
*   **Logs e Telemetria (OpenTelemetry):** O framework fornece ferramentas avançadas de *log* e telemetria nativamente compatíveis com **OpenTelemetry**. Isso prepara o terreno para a construção de *dashboards* focados no controle de performance e avaliação futura.
*   **Trilha de Auditoria (ATIF):** Todos os papéis executados no sistema geram trajetórias compatíveis com o formato **ATIF** (*Agent Trajectory Interoperability Format*). Isso permite um acompanhamento qualitativo rigoroso do comportamento dos Executores em suas diversas funções.
*   **Controle de Cotas Restrito e Expansível:** Inicialmente, o suporte ao controle de consumo de cotas e assinaturas está restrito às provedoras **Anthropic, ChatGPT e MiniMax**. No entanto, este módulo faz parte da lista de abstrações do framework, visando facilitar a integração de novas assinaturas e provedores no futuro.