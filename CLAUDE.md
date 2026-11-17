# CLAUDE.md

Este arquivo orienta o Claude Code neste repositório.

## O que é

Repositório do **OTheater** (*Orchestration Theater*). O OTheater é um sistema de orquestração multi-agente e multi-conta que usa os clientes oficiais (Claude Code, Codex, OpenCode) como Executores, por ACP, e aceita tanto assinaturas quanto chaves de API. Até a Fase 0, o repositório era só de desenho. Desde 2026-11-14 (N33), o código descartável da Fase 0 vai em `spikes/`; o código do produto começa na Fase 1.

A arquitetura de construção é [docs/framework-ideas/arquitetura.md](docs/framework-ideas/arquitetura.md) (v0.72, 2026-11-17). Ela é a referência: quando um documento de `docs/` divergir dela, ajuste o documento de `docs/`. Não mude a arquitetura nem tome as decisões que ela deixa em aberto (seção 12 e [docs/13](docs/13-DECISOES-EM-ABERTO.md)) por conta própria; elas são do dono (Anderson).

Por onde começar:
- [README.md](README.md), que é o índice;
- a arquitetura;
- [docs/00-OBJETIVO.md](docs/00-OBJETIVO.md);
- [docs/02-NUCLEO-COMUM.md](docs/02-NUCLEO-COMUM.md), o resumo do núcleo.

Os antigos documentos 03 a 06 foram apagados em 2026-11-13. Eram a comparação entre as opções com e sem contêineres (descartada em favor da arquitetura) e a alternativa de continuar com o Claude Code + `okit`. A última versão deles está no commit `cb05e35`.

## Regras

- Responda em português do Brasil e use o horário de São Paulo (UTC-3).
- Ao acrescentar informação, diga se foi verificada localmente, vem de fonte secundária ou não foi confirmada. Não apresente hipótese como fato.
- Os termos de uso dos provedores mudam: não afirme o que é permitido sem citar a fonte e a data.
- Branches e pull requests (ordem do dono, 2026-11-15; substitui a regra de commit direto na main de 2026-11-13): todo trabalho vai numa branch, com um PR por passo. Na branch, commit e push são livres. O merge na main só acontece com o ok explícito do dono, por squash merge, e a branch é apagada depois. Não crie repositório remoto nem faça force push.
- Paralelismo como padrão (ordem do dono, 2026-11-16): o que puder ser feito em paralelo é feito em paralelo. Isso vale para chamadas de ferramenta independentes, para subagentes e para adiantar o que não depende de um trabalho em curso. Fica em série o que depende de outro resultado, o que mexe nos mesmos arquivos e o que espera decisão do dono. Dois subagentes que escrevem código não mexem nos mesmos arquivos; se puderem colidir, cada um usa um worktree próprio.
- Mantenha as decisões em `docs/13-DECISOES-EM-ABERTO.md`: mude o estado da pergunta e registre a data e o motivo. Decisões da seção 12 da arquitetura são atualizadas nos dois lugares.
- Projetos relacionados na mesma pasta pai: `orchestration-kit` (o kit `okit` atual), `okit-plugin`, `folder-browser`.
