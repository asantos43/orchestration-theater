# 25 — Guia de adaptadores e de plugins

> Para quem vai escrever um adaptador do OTheater (um contribuidor, por PR) ou um plugin (qualquer um, fora do processo do daemon). A referência de arquitetura é a [§5.18 da arquitetura](framework-ideas/arquitetura.md); este guia diz como seguir o que ela decide e **não a muda**. Onde mora o guia foi decidido na N282 (docs/13) e na D5 do [docs/23](23-PLANO-DA-FASE-11.md).
>
> Marcas: **[V]** verificado no código em 2026-11-23; **[S]** fonte secundária; **[N]** não confirmado.

O exemplo deste guia roda: é o pacote [`examples/adapter-clock`](../examples/adapter-clock), o menor adaptador completo (um `Clock`), testado na CI. Os trechos de código abaixo são cópias **conferidas por um teste** (`examples/adapter-clock/src/guide.test.ts`): se o código do exemplo mudar e o guia não, a CI falha.

## 1. Duas camadas de extensão

| Camada | Quem escreve | Onde roda | Como entra |
|---|---|---|---|
| Interna: **adaptador** | o projeto, e contribuidores por PR | no processo do daemon | pacote `@otheater/adapter-*`, escolhido por id na configuração e montado no `compose.ts` |
| Externa: **plugin** | qualquer um | fora do processo (MCP por stdio) | `plugin.yaml` mais um servidor; a [seção 8](#8-escrever-um-plugin) |

Código de terceiros nunca roda dentro do daemon: um adaptador novo entra no repositório por PR, depois de passar na suíte de conformidade da porta (§5.18). A exceção prevista, depois da v1, são `QuotaProbe` e `Notifier` vindos de plugin.

## 2. Porta e adaptador

- **Porta:** uma interface TypeScript, mais os schemas zod, em `@otheater/core` (`packages/core/src/ports/`), com versão própria (`CLOCK_PORT_VERSION`, `STORE_PORT_VERSION`...). Ela diz o que o núcleo precisa, e o contrato (os erros e as garantias) está no comentário da interface.
- **Adaptador:** uma implementação da porta, num pacote `@otheater/adapter-*` em `packages/adapters/<porta>-<nome>/`. Ele declara uma identidade (`Adapter`: o `id` da configuração e a faixa semver da porta que aceita).
- Quando criar porta: em toda fronteira com o mundo de fora (processo, rede, disco, git, cofre, relógio) e em todo ponto que varia por cliente, provedor ou sistema. A lógica pura **não** tem porta. **Porta nova entra pela regra 5**: um adaptador real, um falso e uma suíte de conformidade, e "porta sem uso real não entra". Criar porta é decisão de arquitetura, do dono; este guia trata de adaptador de porta que já existe.
- O núcleo pergunta **capacidades**, não identidade: não há `if (client === 'codex')` fora do adaptador.

Quais portas existem, quais têm falso e suíte, e o que falta, está na subseção "Revisão das portas" do [docs/23](23-PLANO-DA-FASE-11.md) (conferida em 2026-11-23 [V]). Em resumo, as suítes estão em `packages/sdk/src/conformance/` e os falsos em `packages/core/src/testing/`.

## 3. A regra de dependência

A §5.18 (regra 3) é conferida pelo `dependency-cruiser` (`.dependency-cruiser.js`, `pnpm deps`, que roda no `pnpm verify` da CI). As regras que importam a quem escreve um adaptador:

| Regra | O que proíbe |
|---|---|
| `core-only-zod` | o `core` importar qualquer coisa além do zod e dele mesmo (nem `node:fs`) |
| `adapter-isolation` | um adaptador importar o daemon ou **outro adaptador** |
| `daemon-adapters-only-in-compose` | o daemon importar adaptador fora do `compose.ts` (e do `prompts.ts`) |
| `testing-only-from-tests` | código de produção importar os falsos de `@otheater/core/testing` |
| `no-circular` | dependência circular |

Na prática: o seu adaptador depende de `@otheater/core` (porta, erros, versão) e das bibliotecas dele, e de mais nada do repositório. Se precisar de algo que é de outro adaptador, a coisa comum sobe para o `core`, ou os dois recebem a dependência por construtor, no `compose.ts`. O `pnpm deps` olha só `packages/`: o `examples/` **não** é conferido pelo `dependency-cruiser` **[V: `package.json`, script `deps`]**, e o exemplo segue a regra por convenção.

## 4. As três coisas de toda porta

1. **Adaptador real:** o que o daemon usa em produção.
2. **Adaptador falso:** o que os testes usam no lugar dele (`FakeClock`, `InMemoryStore`, `FakeCodeHost`...), em `@otheater/core/testing`. Só testes o importam.
3. **Suíte de conformidade:** uma função `describe<Porta>Conformance(nome, fábrica)` em `@otheater/sdk` que registra testes do Vitest. A fábrica devolve uma instância nova por teste, e o adaptador passa quando o arquivo passa. **O falso passa na mesma suíte que o real**: é o que garante que os testes do resto do sistema, que rodam sobre o falso, dizem a verdade sobre o real.

Dois adaptadores da mesma porta não precisam de nada além disso: o `SystemClock` e o `FakeClock` rodam a mesma `describeClockConformance`.

## 5. Escrever um adaptador, passo a passo

O exemplo é o `ExampleClock`, uma cópia didática do `SystemClock` (`packages/adapters/clock-system`). Para outra porta, troque a interface e a suíte; os passos são os mesmos.

### 5.1 O pacote

Copie a estrutura de `examples/adapter-clock` (ou de um adaptador de `packages/adapters`): `package.json`, três `tsconfig` (`tsconfig.json`, `tsconfig.src.json`, `tsconfig.test.json`) e `src/`. Pontos que costumam esquecer:

- `package.json`: `"license": "MPL-2.0"`, dependência em `@otheater/core` (`workspace:*`) e, só como `devDependency`, em `@otheater/sdk` e `vitest`. O pacote do adaptador **não** depende do daemon.
- Todo arquivo de código começa com `// SPDX-License-Identifier: MPL-2.0`; o `pnpm verify` (passo `headers`) recusa o que não tiver.
- O pacote entra no workspace pelo glob de `pnpm-workspace.yaml` (`packages/adapters/*`; para um exemplo, `examples/*`). Depois de criar a pasta, `pnpm install` atualiza o `pnpm-lock.yaml`; versione o lock junto.
- Referência de projeto no `tsconfig.json` da raiz (para o `tsc -b` construir o pacote).

### 5.2 A identidade

<!-- trecho: src/index.ts -->
```ts
// SPDX-License-Identifier: MPL-2.0
import { CLOCK_PORT_VERSION, type Adapter } from '@otheater/core';
import { z } from 'zod';

export { ExampleClock } from './clock.js';

/** The configuration of the adapter. It has no options; `strict` makes a typo fail at start-up. */
export const ExampleClockConfigSchema = z.object({}).strict();

/**
 * The identity the composition point reads (architecture 5.18, "Versão dos contratos"): the id
 * written in the configuration, the port, and the range of the port contract that the adapter
 * accepts. `compose.ts` refuses the adapter when the range does not cover `CLOCK_PORT_VERSION`.
 */
export const exampleClockAdapter: Adapter = {
  id: 'example',
  implements: { port: 'Clock', range: `^${CLOCK_PORT_VERSION}` },
};
```

- `id` é o valor que o usuário escreve em `adapters.<porta>` no `config.yaml`.
- `implements.range` é a faixa da porta que o adaptador aceita. Os adaptadores do repositório usam `^${PORTA_PORT_VERSION}`, então a faixa acompanha a versão atual da porta. Num `0.x`, o `^` cobre só o mesmo minor (`^0.1.0` aceita `0.1.x`, não `0.2.0`) [V: regra do semver].
- O schema de configuração é `strict`: uma chave com erro de digitação falha na subida, em vez de ser ignorada. Cada adaptador contribui o schema da própria seção da configuração.

### 5.3 A implementação e os erros tipados

<!-- trecho: src/clock.ts -->
```ts
// SPDX-License-Identifier: MPL-2.0
import { Cancelled, InvalidInput, type Clock } from '@otheater/core';

/** Longest delay a platform timer accepts (2^31-1 ms); a longer wait is split in slices. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The smallest complete `Clock`: wall-clock time and real timers. It is a teaching copy of
 * `SystemClock` (`packages/adapters/clock-system`), with the comments of the contract kept short.
 */
export class ExampleClock implements Clock {
  /** Highest value `now()` has returned, so the clock never goes backwards. */
  #last = 0;

  now(): number {
    this.#last = Math.max(this.#last, Date.now());
    return this.#last;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // A typed error is part of the contract: the caller decides by `code`, never by the message.
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(
        new InvalidInput(`sleep(ms) needs a finite ms >= 0, got ${String(ms)}`),
      );
    }
    if (signal?.aborted === true) return Promise.reject(cancelled(signal));

    return new Promise<void>((resolve, reject) => {
      let remaining = ms;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // Whatever the way out, no timer and no listener may be left behind.
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(cancelled(signal));
      };
      const arm = (): void => {
        const slice = Math.min(remaining, MAX_TIMER_MS);
        remaining -= slice;
        timer = setTimeout(() => {
          if (remaining > 0) {
            arm();
            return;
          }
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, slice);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      arm();
    });
  }
}

function cancelled(signal: AbortSignal | undefined): Cancelled {
  return new Cancelled('sleep cancelled', { cause: signal?.reason });
}
```

**Erros tipados fazem parte do contrato** (§5.18, regra 4). A seleção e a política de retomada decidem pelo `code` do erro, **nunca pelo texto**. Os tipos estão em `packages/core/src/errors.ts` (todos derivam de `OTheaterError`, com `code` estável): `QuotaExhausted`, `AdapterUnavailable`, `PermissionDenied`, `Transient`, `NotFound`, `Conflict`, `VaultLocked`, `Cancelled` e `InvalidInput`. O comentário da interface da porta diz qual erro cada falha deve lançar; a suíte confere. No exemplo: argumento inválido é `InvalidInput`, e um `AbortSignal` abortado é `Cancelled` com `cause = signal.reason`. Regras que valem para qualquer adaptador:

- traduza o erro da biblioteca ou do processo de baixo para o tipo do núcleo, com `{ cause }`; não deixe um erro cru subir;
- não ponha segredo nem texto de conversa na mensagem;
- libere o que abriu (timer, processo, arquivo, listener) em todos os caminhos de saída.

### 5.4 Ligar a suíte de conformidade

<!-- trecho: src/clock.test.ts -->
```ts
// SPDX-License-Identifier: MPL-2.0
import { CLOCK_PORT_VERSION } from '@otheater/core';
import { describeClockConformance } from '@otheater/sdk';
import { describe, expect, it } from 'vitest';
import { ExampleClock, ExampleClockConfigSchema, exampleClockAdapter } from './index.js';

// The suite of the port, the same one that `SystemClock` and `FakeClock` run. A real clock, so
// `advance` lets a little real time pass.
describeClockConformance('ExampleClock', () => ({
  clock: new ExampleClock(),
  advance: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms + 10);
    }),
}));

describe('the identity of the adapter', () => {
  it('declares the Clock port and a range that covers the version of the port', () => {
    expect(exampleClockAdapter.implements).toEqual({
      port: 'Clock',
      range: `^${CLOCK_PORT_VERSION}`,
    });
  });

  it('refuses an unknown option in its configuration', () => {
    expect(ExampleClockConfigSchema.safeParse({}).success).toBe(true);
    expect(ExampleClockConfigSchema.safeParse({ tick: 1 }).success).toBe(false);
  });
});
```

A suíte recebe o que ela não sabe fazer sozinha: aqui, o `advance`, que deixa o tempo passar (um relógio real espera; o `FakeClock` move o tempo). Cada porta tem o seu "harness", descrito no comentário da suíte (`packages/sdk/src/conformance/<porta>.ts`). Além da suíte, escreva os testes do que é só seu (a configuração, as bordas, o que a suíte não cobre). Regras para os testes: nada de rede externa, de cliente real nem de relógio de parede em janela fixa; use o falso e portões por sinal.

Rode só o seu pacote: `pnpm exec vitest run examples/adapter-clock` (ou `packages/adapters/<pacote>`). Neste repositório, rode o vitest com `--maxWorkers=2`.

### 5.5 Versão da porta: o que muda

Cada porta tem uma versão semver em `@otheater/core` (`*_PORT_VERSION`), e o título da suíte de conformidade a mostra (`Clock conformance: ExampleClock (port 0.1.0)`).

- Mudança que quebra o contrato (campo obrigatório novo, erro que muda, semântica que muda) sobe a versão. Um adaptador que declara outra faixa é recusado na subida, com `AdapterUnavailable` dizendo a porta, a versão do daemon e a faixa recebida.
- Mudança que só acrescenta (um método opcional): a §5.18 só escreve que "mudança que quebra o contrato = versão maior"; quanto sobe o resto (minor ou patch, e o efeito do `^` num `0.x`) não está escrito além disso **[N]**. Na dúvida, peça a decisão no PR.
- Quem muda uma porta muda, no mesmo PR, a suíte, o falso e **todos** os adaptadores. A arquitetura admite, numa transição, que o núcleo aceite duas versões maiores **[proposta]**; isso ainda não existe no código [N].

## 6. Montar o adaptador no daemon

O `packages/daemon/src/compose.ts` é o único arquivo do daemon que importa adaptadores (§5.18, "Montagem, sem container"): não há biblioteca de injeção nem resolução por nome em tempo de execução. Para o relógio, o trecho de hoje é:

```ts
adapters.push(checkAdapterRange(systemClockAdapter, 'Clock', CLOCK_PORT_VERSION));
clock = new SystemClock();
```

Para acrescentar um adaptador a uma porta que já tem escolha por id, o caminho é:

1. **Pacote** (`packages/adapters/...`), e a dependência `"@otheater/adapter-<nome>": "workspace:*"` em `packages/daemon/package.json`, com a referência em `packages/daemon/tsconfig.src.json`.
2. **Alias** em `vitest.config.ts`, para os testes importarem o pacote pelo código-fonte sem `tsc -b` antes.
3. **Id na configuração:** acrescente o id à lista da chave (`CLOCK_ADAPTER_IDS`, `VAULT_ADAPTER_IDS`... em `packages/daemon/src/config.ts`), que alimenta `adapters.<porta>` e a aba de Configurações. A chave nova ou o modo novo segue a regra do projeto: é chave de configuração, com padrão, nunca constante.
4. **`compose.ts`:** escolha o adaptador pelo id, valide a seção própria dele com o schema dele (`parseSection`, que nomeia a chave inteira no erro), chame `checkAdapterRange(<identidade>, '<Porta>', <PORTA>_PORT_VERSION)` e guarde o `AdapterRecord` (é ele que `daemon.started` e o status mostram). Veja a escolha do cofre (`keyring` ou `encrypted-file`) como modelo.
5. **Testes:** o `compose.test.ts` confere que as listas do `config.ts` batem com os adaptadores; acrescente o seu caso.
6. **Os testes do resto do daemon continuam sobre o falso**, passado em `overrides` (`overrides.clock`, `overrides.store`...); o adaptador é gravado como `override`.

Duas ressalvas, conferidas no código em 2026-11-23 [V]: (a) hoje o `compose.ts` monta o relógio do sistema sem consultar `adapters.clock` (a lista tem só `system`); o `vault` é o exemplo de escolha por id em uso. (b) Nem toda porta tem escolha por id: `vcs`, `sandbox`, `usage`, `browser` e `telemetry` têm configuração própria, sem seletor de adaptador, (a "Revisão das portas" do docs/23 detalha). Adaptador para essas portas precisa, antes, que o dono decida a chave de escolha. Atualização de 2026-11-25 [V]: o `CodeHost` é montado pelo daemon desde a Fase 11 (`adapters.code_host`: `auto`, `github`, `none`, `fake`), e a porta `IssueTracker` (Fase 11b, P7, N313) tem `adapters.issue_tracker` (`same_as_code_host`, o padrão, `github` ou `none`). Com `same_as_code_host` e o code host `auto`, as issues de cada repositório ficam no GitHub quando o code host dele é o GitHub; nos outros casos não há tracker, e a chamada é `AdapterUnavailable` com o motivo.

O adaptador de um **cliente** (`ClientAdapter`) e o transporte de sessão (`SessionTransport`, `AcpTransport` em `packages/adapters/session-acp`) seguem o mesmo molde, com suítes maiores (`describeClientAdapterConformance`, `describeAgentSessionConformance`), que incluem testes de contrato contra os clientes reais fixados.

## 7. Antes de abrir o PR

Na raiz do repositório, nos pacotes que você tocou:

```bash
pnpm -s build                                  # tsc -b
pnpm exec vitest run --maxWorkers=2 <pacote>   # inclui a suíte de conformidade
pnpm exec eslint <arquivos>
pnpm -s format:check
pnpm deps                                      # a regra de dependência (precisa do build)
pnpm verify:docs                               # licenças, avisos, cabeçalhos SPDX, credenciais
```

A CI roda tudo isso, mais o `pnpm verify` inteiro. O critério é a CI. Um adaptador novo entra por PR, com o ok do dono.

## 8. Escrever um plugin

Um plugin é um processo que fala MCP por stdio, com um `plugin.yaml` que declara ferramentas, papéis, efeitos, eventos e painel. Ele **não** é adaptador: roda fora do daemon, não implementa porta (por ora) e instala-se pela configuração, com as permissões mostradas ao usuário. Este guia **não repete** a referência; use:

- [`packages/sdk/README.md`](../packages/sdk/README.md): o kit (`definePlugin`, `pluginTool`, `servePlugin`), o contrato dos eventos (`plugin.<id>.*`, 16 KB, taxa), a pasta do projeto e a suíte `describePluginConformance`;
- [`docs/reference/plugin-manifest.schema.json`](reference/plugin-manifest.schema.json): o formato do `plugin.yaml`;
- [`examples/plugin-notes`](../examples/plugin-notes): um plugin completo, com manifesto, ferramentas, painel e a suíte de conformidade rodando na CI.

Diferenças para o adaptador que importam ao autor: o plugin depende do SDK (`@otheater/sdk/plugin`), não do `core` por dentro; seus eventos só podem ter o prefixo `plugin.<id>.*`; e a suíte sobe o servidor de verdade, então o `dist/` precisa existir antes do teste (`pnpm build`).

## 9. O que este guia não garante

- **Um contribuidor que nunca viu o repositório consegue seguir o guia até o teste verde:** [N]. Só alguém de fora diz; o dono julga. O que está [V] é que o exemplo compila, passa na suíte do `Clock` e que a CI o roda.
- A suíte do `Clock` é a mais curta. Portas com processo, rede ou disco (`Vcs`, `CodeHost`, `IssueTracker`, `Store`, `ProcessLauncher`) têm harness maior, falsos de processo e portões por sinal; o molde é o mesmo, a conferência é mais longa.
- Sete portas ainda não têm suíte (`ModelCatalog`, `QuotaProbe`, `UsageSource`, `TelemetryStore`, `Sandbox`, `MemoryProbe` e `BrowserSession`), segundo a "Revisão das portas". Para elas, o que vale é o comentário da interface.
