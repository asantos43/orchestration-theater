# Ordens permanentes do dono (OTheater)

Juntadas em 2026-11-25 a partir da memória local do Claude, que não vai junto com o clone. O [CLAUDE.md](../CLAUDE.md) traz as regras gerais e importa este arquivo, então qualquer clone (Linux, macOS ou Windows) já o lê. Quando uma ordem nova do dono vier, ela entra aqui também.

A `.claude/` é versionada de forma seletiva (dono, 2026-11-25). Ficam fora do git o `settings.local.json`, os `worktrees/` e o `launch.json` (que pode ter caminhos da máquina). Como o repositório é público, nada pessoal entra aqui: nenhum caminho com o nome do usuário, e-mail ou segredo.

## Decisões
- Toda dúvida ou decisão em aberto vai ao dono por múltipla escolha (AskUserQuestion), com a recomendada em primeiro e no máximo 4 perguntas por chamada. Depois registre a resposta em `docs/13` e, se for o caso, na seção 12 da arquitetura.
- Em toda pergunta de seleção múltipla, a última opção é "Todas acima", mesmo quando é a recomendada (aí leva o "(Recomendado)" no rótulo).
- Todo valor padrão novo vira uma chave de configuração, de preferência com vários modos. O que for escolha do Claude é marcado [proposta] e vai como pergunta ao dono.
- O Claude age como co-dono: atualiza tudo o que uma mudança toca (arquitetura, docs/13, planos) e propõe riscos e capacidades, marcando-os como proposta. A arquitetura e as decisões em aberto continuam com o dono.
- Toda situação que hoje só vai ao log (aviso, desvio, falha que degrada) também gera um evento no protocolo, para hooks e plugins.

## Branches, PRs, CI e merge
- Cada passo tem uma branch e um PR, sempre a partir da main e com arquivos próprios, sem branch sobre branch. Commit e push na branch são livres.
- Nunca use `git add -A`: adicione os arquivos por nome. Não faça force push nem rebase, e não crie repositório remoto.
- **Só um PR roda a CI por vez.** Disparar um workflow por `workflow_dispatch` também ocupa a vez. Os outros PRs fazem commit e esperam antes do push.
- **Com a CI verde, o merge é feito sem pedir** (Fases 11, 11b e 11c autorizadas, N319; a Fase 12 em diante ainda precisa de nova autorização), sempre por squash, e a branch é apagada depois.
- O repositório não tem proteção de branch, então `gh pr merge --auto` mescla na hora: confira antes `gh pr checks N`.
- Uma CI verde vale para outro commit com a mesma árvore.
- Na máquina do dono, o merge passa por `nota-de-passagem/merge-pr.sh` e `ci-tree.sh`. Esses scripts não estão no git e têm caminhos fixos daquela máquina. Em outra máquina, use `gh pr merge N --squash --delete-branch` depois de conferir os checks.
- As ondas dos planos das fases começam sem pedir ok.

## Execução e recursos
- Subagentes de código rodam com `model: sonnet` e `effort: high`; a conversa principal planeja e confere. Nunca rode mais de 3 agentes de código ao mesmo tempo.
- O que for independente roda em paralelo: chamadas de ferramenta, subagentes, trabalho adiantado. Fica em série o que depende de outro resultado, o que mexe nos mesmos arquivos e o que espera o dono.
- Memória:
  - rode `vitest run --maxWorkers=2`, um vitest por vez;
  - rode o eslint e o prettier só nos arquivos tocados;
  - o `eslint .` inteiro passa de 6 GB de heap: use `NODE_OPTIONS=--max-old-space-size=8192`;
  - rode `pnpm verify:docs` quando mexer em docs.
- Esperas:
  - nunca use `pgrep -f` com um padrão que aparece no próprio comando;
  - todo comando leva `timeout`;
  - no fim de cada passo, pare as tarefas de espera que sobrarem.
- Rodadas reais com Claude Code, Codex e OpenCode (modelos OpenAI) estão autorizadas sem ok por rodada, usando modelos baratos. Nessas rodadas:
  - nunca leia credenciais (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.config/gh`, perfis de teste);
  - nunca faça login pelo dono;
  - confira memória e disco antes;
  - use `timeout`.

## Segurança (o repositório é público)
- Nenhum segredo, chave, token, e-mail ou caminho com o nome do usuário entra em código, teste, fixture, log ou doc.
- Nada é publicado: nenhum release, tag, `gh release` ou `npm publish`. Não dispare o workflow de release e não defina variáveis nem segredos do GitHub.
- Não instale serviço ou tarefa real na máquina (no Windows, nada de `schtasks` de verdade) e não rode o instalador contra o perfil real.
- Não use o chaveiro real (no Windows, o Credential Manager). Não mate processos de outros, não use `taskkill /im` por nome e não use privilégio de administrador.

## Estilo
- Responda em português do Brasil, no horário de São Paulo (UTC-3), em mensagens curtas.
- Marque cada informação: [V] verificada localmente, [S] fonte secundária, [N] não confirmada.
- Termos de uso dos provedores: sempre cite a fonte e a data.
- Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. O corpo dos PRs termina com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
