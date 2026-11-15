# spikes/

Código **descartável** da Fase 0 ([arquitetura](../docs/framework-ideas/arquitetura.md), §10, "Fase 0 — Validações e escolha da base"). Decidido em 2026-11-14 (N33 do [docs/13](../docs/13-DECISOES-EM-ABERTO.md)).

- Cada medição fica numa subpasta própria, com um `README.md` que diz o que foi medido, em qual máquina e sistema, com quais versões, e o resultado.
- O resultado medido vale mais que o suposto: o critério de aceite da Fase 0 é "cada item com resposta medida, não suposta".
- Nada daqui segue para a Fase 1. O que for aproveitado é reescrito em `packages/`.
- Segredos, logins e arquivos de sessão dos clientes nunca entram no repositório.
- O repositório git de teste e as worktrees de cada spike ficam fora do repositório, em `$SPIKE_SCRATCH` ou, sem a variável, em `<tmpdir>/otheater-spikes/<spike>/`. Caminhos com o nome do usuário não entram no código (2026-11-15).

O entregável da Fase 0 é o relatório dos spikes, os ADRs (inclusive fork sim ou não) e os ajustes na arquitetura.
