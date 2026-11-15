# spikes/quota-probes: sondas de cota

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, item "Cota"). Código **descartável**: mede de onde sai o sinal de cota de cada cliente (Claude Code, Codex, MiniMax) e quanto custa lê-lo. As saídas pesadas ficam em `out/` (ignorado pelo git).

Medido em 2026-11-15 (UTC-3), uso pessoal, nas assinaturas do dono (Claude Pro, ChatGPT Plus). Nenhum login foi feito, nenhuma credencial foi lida, `~/.claude/settings.json`, `~/.codex/config.toml` e `~/.config/opencode` não foram tocados (do `settings.json` só se viu que a chave `statusLine` existe, não o conteúdo). A chave da MiniMax do dono não foi usada nem lida. Marcas: **[V]** verificado localmente, **[S]** fonte secundária (documentação ou código lido, não executado), **[N]** não confirmado ou hipótese. E-mail, `accountId`, `installationId` e caminhos com o nome do usuário ficam só em `out/`; este README os omite.

Este spike completa `spikes/acp-claude` (item 9, cota) e `spikes/acp-codex` (item 8, cota).

## Máquina e versões

| Item | Valor |
|---|---|
| Sistema | Fedora 45, kernel 7.3.3-300.fc45.x86_64, 12 núcleos, 30 GB [V] |
| Node | v24.18.0 (roda `.ts` direto) [V] |
| Claude Code (CLI) | 2.1.325, interativo dentro de `tmux` 3.8 (socket próprio) [V] |
| Adaptador ACP do Claude | `@agentclientprotocol/claude-agent-acp` 0.107.0, instalado em `spikes/acp-claude/node_modules` e reaproveitado [V] |
| SDK ACP do cliente | `@agentclientprotocol/sdk` 2.7.0 [V] |
| Codex | codex-cli 0.169.0 do PATH (`codex app-server`) e `@agentclientprotocol/codex-acp` 2.6.0 (de `spikes/acp-codex`) [V] |
| Modelo (Claude) | `haiku` (`claude-haiku-5-5`), esforço `low` [V] |

## Prompts e custo do spike

- **23 prompts de modelo no Claude** (Haiku, esforço `low`): 20 pelo ACP (um deles de 601 a 662 tokens de saída, "escreva de 1 a 300") e 3 de uma palavra na statusline interativa. Contados em `out/prompts.log` e na tela [V].
- Efeito na cota da assinatura Claude: a janela de 5 h foi de 0 para 1% e a semanal de 0 para 1% (resolução de 1 ponto). Ou seja, 23 prompts de Haiku ficaram abaixo de ~2 pontos [V].
- Cada sessão nova do Claude gasta ~40 mil tokens só de contexto-base (15 a 16 mil escritos no cache + 23 a 26 mil lidos do cache no primeiro prompt; US$ 0,0087 reportado pelo `claude` no total da sessão) [V].
- Codex: **zero prompts de modelo**. Só `account/rateLimits/read` (6 leituras) e um `/status` local do adaptador [V].
- MiniMax: **zero chamadas com chave real**. Só 4 chamadas com uma chave falsa, para ver o formato do erro [V].

## Resultado por item

| # | Item | Resultado | Marca |
|---|---|---|---|
| 1 | `--settings` aplica a `statusLine`? | **Sim.** `claude --settings <arquivo> --model haiku --effort low` com `statusLine: {type:"command", command:"node …/statusline-probe.mjs"}` rodou o probe e desenhou o texto dele na barra. Isso **vale mesmo com o `statusLine` do `~/.claude/settings.json` do dono**: o do `--settings` venceu. A pasta precisa estar confiável: na primeira vez o `claude` mostra o diálogo "trust this folder" e a statusline só roda depois do aceite (a documentação diz o mesmo, ver abaixo). | V (aplica e vence); S (regra da confiança) |
| 1 | Campos de `rate_limits` | `rate_limits.five_hour` e `rate_limits.seven_day`, cada um com **`used_percentage`** (inteiro de 0 a 100 nas 19 chamadas do `calls.jsonl` principal e nas 6 das 3 aberturas) e **`resets_at`** (epoch em segundos). Nada mais: sem `status`, sem sobreuso, sem `limit_type`. Sem `spend_limit` (só aparece atrás de gateway). O JSON inteiro da statusline não traz e-mail nem conta. Quando o `resets_at` passa, a janela some do JSON (documentado). `five_hour.resets_at` da statusline foi **igual** ao `resetsAt` do ACP (mesma janela). A documentação fala em decimais (exemplo 23,5); aqui só vieram inteiros. | V (campos, inteiros); S (decimais, janela some) |
| 1 | Quando `rate_limits` aparece | A **primeira chamada** da statusline (~1 s depois de abrir) vem com `rate_limits: null`. Com a statusline dirigida por evento, ele só apareceu no JSON depois de uma resposta (a documentação diz "só depois da primeira resposta da sessão"). **Descoberta:** com `refreshInterval` curto, o `rate_limits` já está preenchido **2,2 a 2,5 s depois de abrir o `claude`, sem enviar prompt algum** (3 de 3 repetições; a sessão tinha `total_api_duration_ms: 0` e 0 tokens). Origem desse dado não identificada [N]. | V (aparece sem prompt); N (origem) |
| 1 | Frequência da statusline | **Dirigida por evento, não por relógio.** Uma chamada ao abrir, **uma por resposta completa** (3 prompts, 3 chamadas; não há uma por trecho de streaming), uma por troca de modo de permissão (Shift+Tab) e uma ao sair do diálogo `/model`. Parada de 11:20:41 a 11:25:19 (4,6 min, sem `refreshInterval`): **zero chamadas** no `calls.jsonl`. O atraso do fim da resposta até a chamada é de ~0,3 s (a documentação fala em debounce de 300 ms). Com `refreshInterval: 5` (opcional, mínimo 1 s) o comando roda a cada 5,0 s (6 chamadas em 30 s), **mas os percentuais não mudam**: o relógio re-roda o comando, não busca dados novos. Só uma resposta da API (ou a abertura da sessão) atualiza o percentual. Cada chamada do probe em Node leva ~0,09 s e 53 MB de pico. | V |
| 2 | Unidade de `utilization` do `_claude/rateLimit` | **Fração de 0 a 1, com 2 casas.** Dois pontos de comparação, no mesmo minuto: ACP `five_hour.utilization = 0,01` e `seven_day.utilization = 0,01` (11:25:09 UTC) contra statusline `five_hour.used_percentage = 1` e `seven_day.used_percentage = 1` (11:25:19 UTC); as duas janelas com o mesmo `resets_at`. Se fosse percentual, 0,01 apareceria como 0 na statusline. **Ressalva:** os dois pontos são no valor mínimo (1%); não há um ponto alto (por exemplo 0,35 contra 35). Resolução do ACP: 0,01 (1 ponto), igual à da statusline. | V (com a ressalva) |
| 2 | Quando o ACP manda o evento | `usage_update._meta["_claude/rateLimit"]` chega ~1,7 a 2,2 s depois do `session/prompt`, junto dos cabeçalhos da resposta, e **só quando algum valor mudou**: em 20 prompts houve 4 eventos (o 1º de cada sessão e o do prompt em que o 5h virou 0,01). Sem prompt, `session/new` não traz o evento. Os campos extras em relação à statusline: `status` (`allowed`), `rateLimitType`, `overageStatus` / `overageDisabledReason` / `isUsingOverage` e `status` por janela. | V |
| 3 | `account/rateLimits/read` do Codex | **Medido.** `codex app-server` por stdio (`initialize`, `initialized`, `account/rateLimits/read`), sem prompt de modelo. Formato na seção própria abaixo. Primária (300 min) e secundária (10080 min) com `usedPercent` inteiro, `resetsAt` em epoch s, `planType: "plus"`, `credits`, `rateLimitReachedType`, `rateLimitsByLimitId.codex`, `rateLimitResetCredits`, `accountId`. Valores no momento da medição: 0% e 0% (janela nova), 3 leituras iguais. | V |
| 3 | Comparação com `/status` | O `/status` do `codex-acp` (tratado localmente, sem turno do modelo) imprime a **mesma informação**, com outra apresentação: `100% left` (= 100 − `usedPercent`), hora local de reset sem segundos (`resets 13:23`; `resetsAt` = 16:23:17 UTC = 13:23 em UTC-3; a data só aparece se não for hoje: `22:38 on Nov 21` = `secondary.resetsAt`), `Credits: 0` (= `credits.balance` "0"). O `/status` **omite** `windowDurationMins`, `rateLimitReachedType`, `rateLimitResetCredits` e `limitId`. Use o JSON, não o texto. | V |
| 4 | MiniMax `token_plan/remains` | **Pendente do dono.** Endpoint e autenticação pela documentação oficial; o formato da resposta **não** é documentado pela MiniMax. Script pronto (`src/q4-minimax-remains.ts`). Com uma chave falsa, o endpoint responde **HTTP 200** com erro em `base_resp.status_code: 1004` (não 401), nos dois hosts. Seção própria abaixo. | S (doc); V (erro com chave falsa); N (resposta real) |
| 5 | Custo, latência e segundo plano | Tabela "Custo, latência e segundo plano" abaixo. | V |

### Statusline: o que o `claude` manda no stdin

Chaves de topo do JSON (2.1.325, plano Claude Pro, sem gateway) [V]: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id` (só depois do primeiro prompt), `effort`, `model`, `workspace`, `version`, `output_style`, `cost`, `context_window`, `exceeds_200k_tokens`, `prompt_cache` (só depois da primeira resposta), `fast_mode`, `thinking`, `rate_limits` (ausente ou nulo antes do primeiro dado). O JSON tem `transcript_path` e `cwd`: o probe grava tudo em `out/` e o README só cita os nomes.

```jsonc
// statusline, depois de ~20 prompts (valores reais, sem identificadores)
"rate_limits": {
  "five_hour": { "used_percentage": 1, "resets_at": 1794759600 },   // epoch s; 5 h
  "seven_day": { "used_percentage": 1, "resets_at": 1794834000 }    // epoch s; 7 d
}
```

Fonte: <https://code.claude.com/docs/en/statusline>, consultada em 2026-11-15 [S]. Pontos relevantes que ela diz e que aqui só foram parcialmente reproduzidos: o comando roda a cada mensagem do assistente, em `/compact`, na troca de modo e de modo vim, com debounce de 300 ms e cancelamento do script anterior se ainda rodar; `refreshInterval` (mínimo 1) é opcional; `rate_limits` só existe para assinantes Pro, Max e Ultra (ou gateway com limite de gasto) e cada janela pode faltar; uma pasta que não foi confiada deixa a statusline em branco (`Status line command skipped: workspace trust not accepted`); no Windows o comando roda por Git Bash ou PowerShell. A confiança da pasta **não foi testada em perfil de daemon** (`CLAUDE_CONFIG_DIR` próprio): fica pendente.

### Valor de abertura contra valor depois do prompt

Na sessão aberta sem prompt, a statusline mostrou `five_hour 0%` e `seven_day 1%`; depois de um prompt de uma palavra no mesmo minuto, `five_hour 1%`. A causa **não está confirmada** [N]: pode ser fonte diferente no arranque (por exemplo outro arredondamento do mesmo valor) ou o prompt ter virado o ponto. Em uso, trate a statusline como **±1 ponto**.

### Codex: formato de `account/rateLimits/read`

Pedido: `{"method":"account/rateLimits/read"}` (sem parâmetros) ou `{"excludeResetCreditDetails": true}`, que o esquema documenta como "pular a consulta de detalhe de créditos de reset, para consultas em segundo plano" (`codex app-server generate-json-schema`, v0.169.0) [S, esquema lido; a chamada com o parâmetro foi feita e funcionou: V].

```jsonc
// resposta (accountId omitido)
{ "ordinaryUsageAllowed": true,
  "rateLimits": {                        // visão antiga, de um balde só
    "limitId": "codex", "limitName": null, "normalModelSlug": null,
    "primary":   { "usedPercent": 0, "windowDurationMins": 300,   "resetsAt": 1794759797 },  // 5 h
    "secondary": { "usedPercent": 0, "windowDurationMins": 10080, "resetsAt": 1795311512 },  // 7 d
    "credits": { "hasCredits": false, "unlimited": false, "balance": "0" },
    "individualLimit": null, "spendControlReached": false,
    "planType": "plus", "rateLimitReachedType": null },
  "rateLimitsByLimitId": { "codex": { /* mesmo objeto */ } },   // visão por balde
  "rateLimitResetCredits": { "availableCount": 0, "credits": [] },
  "accountId": "<omitido>", "rateLimitUpsell": null }
```

- `usedPercent` é **inteiro** de 0 a 100 [V]. `resetsAt` é epoch em segundos [V]. `windowDurationMins` diz o tamanho da janela (300 e 10080): leia o campo em vez de supor que `primary` é 5 h [V; esquema: `primary`/`secondary` podem ser nulos, S].
- Com 0% de uso, `resetsAt` ficou **fixo** nas 3 leituras e nas duas chamadas de cada uma (não é "agora + 5 h" deslizante) [V].
- `rateLimitReachedType` (esquema [S]): `rate_limit_reached`, `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`. Só `null` foi observado.
- `account/rateLimits/updated`: notificação "esparsa", a mesclar com a última leitura (descrição do esquema, [S]). **Não chegou** nas leituras sem turno; só chegaram `remoteControl/status/changed` e `account/updated` (`authMode: chatgpt`, `planType: plus`) logo após o `initialize` [V]. Se ela chega durante um turno real, não foi medido.
- O esquema também tem `account/rateLimits/consume…ResetCredit…` (gasta um crédito de reset): **o spike não o chama e a Fase 1 também não deve** sem ordem do dono [S].

### MiniMax: o que se sabe sem a chave

Documentação oficial da MiniMax (consultada em 2026-11-15):

- FAQ do M Plan, "How can I check M Plan usage?", método 3 "Use the API endpoint": `https://platform.minimax.io/docs/m-plan/faq`. Pede `GET https://www.minimax.io/v1/token_plan/remains` com `Authorization: Bearer <chave do M Plan>` e `Content-Type: application/json`. **A página não traz exemplo de resposta nem campos** [S].
- A CLI oficial tem `mmx quota` ("mostra uso e cota restante"), sem formato de saída nem endpoint documentados (<https://platform.minimax.io/docs/m-plan/minimax-cli>) [S].

Fontes **secundárias** (não oficiais; a resposta real não foi vista):
- Issue 99 do repositório MiniMax-AI/MiniMax-M2 (aberta em 2026-03-27, fechada em 2026-04-17): `current_interval_usage_count` e `current_weekly_usage_count` **parecem trazer o restante, não o consumido**; a resposta de um colaborador só diz que o endpoint "foi atualizado" para `…/v1/token_plan/remains`, sem confirmar o nome dos campos (<https://github.com/MiniMax-AI/MiniMax-M2/issues/99>) [S].
- Nota de terceiros (<https://github.com/me-speaker/token_manager/blob/master/minimax-token-plan-api.md>): `data.current_interval_{total,usage}_count`, `current_interval_reset_time`, `current_weekly_{total,usage}_count`, `current_weekly_reset_time` (ISO 8601 com +08:00), e `model_remains[]` com `model`, `remains`, `total` só em planos Plus e Ultra; chave de assinatura (chave de pagar-por-uso dá 401/403); `api.minimax.io` e `api.minimaxi.com` como hosts alternativos; a própria nota diz que o formato de sucesso **não foi confirmado numa resposta real** [S].
- Há relato de que `remains_time` diminui mesmo sem chamadas (issue 47 do MiniMax-M2.7) [S, não aberta].

Medido aqui com **chave falsa** (não é a do dono), 2 chamadas em cada host [V]: `GET /v1/token_plan/remains` em `www.minimax.io` e em `api.minimax.io` respondem **HTTP 200** com corpo `{"base_resp":{"status_code":1004,"status_msg":"login fail: Please carry the API secret key in the 'Authorization' field of the request header"}}`. Latência com erro: 0,43 a 1,31 s (a primeira chamada de cada host foi a mais lenta). Consequência: o código **não pode** tratar HTTP 200 como sucesso; precisa olhar `base_resp.status_code`.

**Como o dono mede** (sem gravar a chave; só lê `MINIMAX_API_KEY` do ambiente):

```sh
cd spikes/quota-probes
MINIMAX_API_KEY=... node src/q4-minimax-remains.ts 3     # 3 chamadas em cada host
```

O script grava a resposta crua em `out/q4-minimax-<host>-<n>.json` (sem cabeçalhos, sem a chave) e imprime o total, o restante e o percentual usado, supondo que `*_usage_count` seja o **restante**. O dono precisa conferir isso contra a página de uso do console. **Medição pendente do dono.**

## Custo, latência e segundo plano

| Sonda | Gasta cota? | Custo | Latência | Roda a cada N min sem sessão aberta? |
|---|---|---|---|---|
| Statusline do Claude, **lendo o último JSON** | Não: só lê um arquivo | 0 | ~0 (arquivo local) | **Sim, mas o dado é velho**: só muda quando uma sessão real responde. Com a máquina ociosa, o último valor fica parado até o `resets_at`; depois disso a janela está vencida e o percentual é desconhecido. |
| Statusline do Claude, **abrindo um `claude` só para ler** (arranque sem prompt) | **Não medido** [N]. A sessão registrou 0 tokens e `total_api_duration_ms: 0`; o contador da assinatura tem resolução de 1 ponto e não mostra se o arranque conta. | ~410 MB de RSS por ~3 s; um processo `claude` e um `node` por leitura | `rate_limits` pronto em 2,2 a 2,5 s (mediana 2,3 s) depois de abrir; 3 repetições | **Sim, tecnicamente** (precisa de um pty: foi feito com `tmux`; sem terminal o `claude` interativo não desenha a statusline; **pasta já confiada**). Valor ±1 ponto. |
| Evento `_claude/rateLimit` do ACP | **Sim**: só chega com um prompt (~40 mil tokens, ~1,7 a 2,2 s até o evento, ~6 s por prompt de 600 tokens de saída em Haiku/`low`) e só se um valor mudou | ~40 mil tokens de contexto por sessão nova; dentro de uma sessão aberta, nada extra | 1,7 a 2,2 s depois do envio | **Não como sonda** (exige prompt). Serve como **complemento passivo** das sessões que já rodam, sem custo extra. |
| `account/rateLimits/read` do Codex | Não: sem turno de modelo, nenhum token | 1 processo `codex app-server`, ~114 MB de RSS, ~1 s de vida | `initialize` 0,21 a 0,61 s (a 1ª, a frio, foi a 0,61); 1ª leitura 0,41 a 0,72 s; 2ª leitura no mesmo processo 0,18 a 0,32 s | **Sim.** Não precisa de sessão, nem de worktree, nem do adaptador ACP. Nenhum processo restou depois. |
| `token_plan/remains` da MiniMax | Em tese não (é uma consulta HTTP; a documentação não diz) | 1 requisição HTTP | 0,4 a 1,3 s medidos **com chave falsa**; com chave real, pendente | **Sim**, se a resposta real se confirmar. Pendente do dono. |

## Consequências para o medidor de cotas

Tudo abaixo é **[proposta]**; a decisão é do dono. Nada disso muda a arquitetura por conta própria.

1. **Claude (assinatura): sonda = último JSON da statusline por perfil [proposta].** O daemon grava, no `settings.json` do perfil, `statusLine.command` apontando para um script de uma linha que copia o stdin para o arquivo do perfil e acrescenta a hora da escrita. O `--settings` provou que isso funciona e vence a statusline do usuário. Regras de leitura: (a) descarte uma janela cujo `resets_at` já passou, como o próprio Claude Code faz; (b) guarde a hora da escrita e mostre "lido há N min"; (c) resolução de 1 ponto, então o limiar `near_limit` não deve ser mais fino que isso; (d) como a statusline só roda numa pasta confiada, a preparação do perfil precisa marcar a pasta de trabalho como confiada (**a testar na Fase 1** com `CLAUDE_CONFIG_DIR` de perfil).
2. **Claude sem sessão há tempo [proposta, a decidir]:** a arquitetura (5.6) hoje manda **não consultar** o Claude sem sessão. Esta medição mostra uma alternativa: abrir um `claude` interativo num pty com `refreshInterval: 1`, esperar o primeiro `rate_limits` (~2,3 s) e fechar. Fica como chave `quota.claude_probe: statusline_file | statusline_startup | off`, com **`statusline_file` como padrão**. Antes de oferecer `statusline_startup`, é preciso responder duas perguntas que este spike **não** respondeu: o arranque conta contra a cota? o valor do arranque tem o mesmo arredondamento do valor depois de um prompt (viu-se 0% contra 1%)?
3. **Claude, complemento passivo [proposta]:** o adaptador ACP repassa `_claude/rateLimit` com `status`, sobreuso e as duas janelas. Guarde o último valor visto de cada sessão (ele só chega quando algo muda), **converta fração para percentual (×100)** e use `status != allowed` como sinal forte de esgotamento. Não use como sonda (exige prompt de ~40 mil tokens). A unidade (fração) vale para a versão 0.107.0 do adaptador e deve ser reconferida a cada atualização [N].
4. **Codex: sonda = `account/rateLimits/read` num `codex app-server` [proposta].** Sem custo de tokens, 0,6 a 1,0 s a frio, não precisa de sessão. Duas formas: (a) **um processo por leitura** (lança, lê, mata; ~114 MB por ~1 s), a mais simples e sem estado; ou (b) um `app-server` de vida longa por perfil, que também recebe `account/rateLimits/updated`. Para o intervalo `quota.recheck_every` (padrão 15 min), a forma (a) basta. Use `excludeResetCreditDetails: true`, leia `windowDurationMins` em vez de supor que `primary` é 5 h, trate `primary`/`secondary` como opcionais, use `rateLimitReachedType != null` como esgotado e **nunca** chame `account/rateLimits/consume…`. O `/status` não serve de fonte (só o texto, menos campos). Perfis isolados usam `CODEX_HOME` próprio; o login em perfil isolado segue pendente em `spikes/acp-codex`.
5. **MiniMax: `GET /v1/token_plan/remains` [proposta, depende da medição do dono].** Use `www.minimax.io` (o da documentação oficial); `api.minimax.io` também respondeu. **Confira `base_resp.status_code` mesmo com HTTP 200.** Considere os nomes `*_usage_count` e `remains` **ambíguos** (podem ser o restante) até o dono comparar a resposta com o console. Marcar o schema como frágil, como a arquitetura já faz.
6. **Estado `unknown` [proposta]:** quando a sonda do cliente não tem dado novo (Claude sem sessão, janela vencida), o perfil fica `unknown` e a próxima sessão real é o teste, como a arquitetura já prevê. Esta medição não muda essa regra para `statusline_file`.
7. **Normalização [proposta]:** guarde sempre `used_pct` (0 a 100), `resets_at` (epoch s UTC), `window_minutes`, `source`, `read_at` e `resolution_pts` (1 para as três fontes medidas), para o medidor não depender da unidade de cada cliente.

## Pendências (não medido)

- Medição real do `token_plan/remains` (precisa da chave do dono): formato da resposta, significado de `*_usage_count`, unidade dos tempos, latência real.
- Se o arranque do `claude` sem prompt gasta cota (a resolução de 1 ponto não mostra) e por que o valor de arranque (0%) difere do valor depois do prompt (1%).
- Unidade de `utilization` com um valor **alto** (≥ 0,10): só há dois pontos, os dois em 1%. Para fechar, comparar ACP e statusline numa janela já bem usada.
- Statusline em perfil de daemon: confiança da pasta com `CLAUDE_CONFIG_DIR` próprio e se o `statusLine` do `--settings` também vale em perfil sem `settings.json` do usuário. Também não testado: rodar sem `tmux` (pty de Node) e no Windows (`ConPTY`).
- Codex: `account/rateLimits/updated` durante um turno real; formato com uso acima de 0% e com limite atingido (`rateLimitReachedType`); plano Pro/Team.
- Claude: formato da statusline com `spend_limit` (gateway) e com o limite semanal esgotado (campo ausente ou 100?).
- Cota do OpenCode (sem API documentada): fora deste spike.

## Como rodar

```sh
npm install --ignore-scripts
npx tsc --noEmit
# usa o adaptador instalado em ../acp-claude/node_modules (rode `npm install` lá antes)
```

| Script | O que faz | Custo |
|---|---|---|
| `src/statusline-probe.mjs` | Comando de `statusLine`: grava o stdin em `out/statusline/` (ou em `$QP_STATUS_DIR`) | 0 |
| Item 1 (manual) | `tmux -L <socket> new-session -d -c <repo-de-teste> "claude --settings <arq.json> --model haiku --effort low"`, com `<arq.json>` = `{"statusLine":{"type":"command","command":"node …/src/statusline-probe.mjs"}}` (acrescente `"refreshInterval": 5` para o relógio). Aceite o diálogo de confiança da pasta de teste, mande 1 ou 2 prompts, `/exit`, `tmux -L <socket> kill-server`. Nunca aperte Enter no diálogo `/model` (grava o padrão global) | ~2 prompts Haiku |
| `src/q1b-startup-probe.ts` | Abre o `claude` 3 vezes num tmux próprio, sem prompt, e mede o tempo até o primeiro `rate_limits` | 0 prompts (custo do arranque: ver pendências) |
| `src/q2-acp-utilization.ts N tag` | N prompts pelo `claude-agent-acp`, registra `_claude/rateLimit` por prompt | N prompts Haiku (~40 mil tokens na 1ª, cache depois) |
| `src/q3-codex-ratelimits.ts 3` | 3 processos `codex app-server`, `account/rateLimits/read` | 0 tokens |
| `src/q3b-codex-status.ts` | `/status` do `codex-acp`, para comparar | 0 tokens |
| `src/q4-minimax-remains.ts [N] [--bad-key]` | MiniMax; precisa de `MINIMAX_API_KEY` (pendente do dono); `--bad-key` só mostra o formato do erro | 1 requisição por chamada |

Os scripts esperam o repositório de teste em `$SCRATCH/repo` (`src/paths.ts`). Saídas em `out/`: `statusline/` (JSON cru de cada chamada, `calls.jsonl`), `statusline-startup-N/`, `q2*-rows.jsonl`, `q3-codex-raw.jsonl` (tem `accountId`), `q3b-status.json`, `q4-*.json`, `prompts.log`.

## Avisos

- `lib.ts`, `log.ts` e `proc.ts` são cópias de `spikes/acp-claude/src/` (só `ADAPTER_JS` e `paths.ts` mudam), para não escrever em `acp-claude/out/`.
- A statusline `--settings` e o `claude` interativo usaram o login e os plugins do dono (hooks, painel do orquestrador na tela, modo `auto`). Isso não afeta o `rate_limits`, mas afeta o RSS do `claude` (~410 MB com tudo carregado).
- O `/tmp` desta máquina é um tmpfs com cota por usuário; este spike usou menos de 5 MB.
