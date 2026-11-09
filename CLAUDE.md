# CLAUDE.md

Este arquivo orienta o Claude Code neste repositório.

## O que é

Repositório de **desenho** de um sistema de orquestração multi-agente e multi-conta que usa as assinaturas dos clientes oficiais (Claude Code, Codex, OpenCode), sem chaves de API. **Não há código ainda.** A arquitetura definitiva **não foi decidida** pelo dono (Anderson): não implemente nem escolha uma arquitetura por conta própria.

Comece por `README.md` (índice) e `docs/00-OBJETIVO.md`. As duas arquiteturas em comparação são **com contêineres** (`docs/03`) e **sem contêineres** (`docs/04`), sobre o mesmo núcleo (`docs/02`); a comparação está em `docs/05` e as perguntas abertas em `docs/13`. Continuar com o Claude Code + `okit` é uma alternativa fora desse eixo (`docs/06`).

## Regras

- Responda em português do Brasil e use o horário de São Paulo (UTC-3).
- Ao acrescentar informação, diga se foi verificada localmente, vem de fonte secundária ou não foi confirmada. Não apresente hipótese como fato.
- Termos de uso dos provedores mudam: não afirme o que é permitido sem citar a fonte e a data.
- Não faça push, não crie repositório remoto e não faça commit sem o dono pedir.
- Mantenha as decisões tomadas em `docs/13-DECISOES-EM-ABERTO.md` (mude o estado da pergunta e registre a data e o motivo).
- Projetos relacionados na mesma pasta pai: `orchestration-kit` (o kit `okit` atual), `okit-plugin`, `folder-browser`.
