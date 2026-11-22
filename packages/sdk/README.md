# @otheater/sdk

SDK interno do OTheater. Tem duas partes: as **suítes de conformidade dos adaptadores** (ponto de entrada `@otheater/sdk`, usadas pelos pacotes do monorepo) e o **kit para escrever plugins** (subpath `@otheater/sdk/plugin`, Fase 9, P9, decisão N240). Este README trata do kit de plugins. O código e os comentários estão em inglês; o texto é pt-BR.

Legenda: **[V]** verificado localmente; **[proposta]** escolha do passo P9, ainda sem ok do dono.

## O que é um plugin

Um plugin é um processo que fala MCP por stdio (o daemon é o cliente, decisão N232) e traz um `plugin.yaml` ([formato](../../docs/reference/plugin-manifest.schema.json)). O manifesto diz quais ferramentas existem, quem as vê (`roles`), o que cada uma faz no mundo (`effects`: `read`, `local_write`, `network`, `external_write`), se exigem aprovação do Producer, quais eventos o plugin publica, o painel e os textos em `i18n`. O código diz o que cada ferramenta faz. O `definePlugin` amarra os dois e recusa o par que discorda.

## Peças (`@otheater/sdk/plugin`)

- `definePlugin({ manifest, tools })`: valida o manifesto com o validador do P3 (`@otheater/core`, o mesmo que a instalação roda) e confere que toda ferramenta do manifesto tem código e que todo código tem ferramenta no manifesto. Lança `PluginManifestError` (com o caminho de cada campo) ou `PluginDefinitionError`.
- `pluginTool({ input?, description?, handler })`: uma ferramenta. `input` é um `z.object`; o `handler(args, { tool, emit })` devolve qualquer valor JSON (vai como texto JSON no resultado MCP). Um `throw` vira resultado com `isError: true` e a mensagem da exceção.
- `readPluginManifest(arquivo)`: lê e valida um `plugin.yaml`. O servidor do exemplo lê o do próprio pacote, para o manifesto ser a única fonte de verdade.
- `servePlugin(plugin, { version?, eventMaxBytes?, onerror? })`: sobe o servidor MCP por stdio (`@modelcontextprotocol/server`), registra cada ferramenta e devolve `{ events, close() }`. O processo termina sozinho quando o stdin fecha. Nada além de protocolo vai ao stdout; o log vai ao stderr.
- `pluginProjectDirectory()`: a pasta do projeto, ver a seção seguinte.
- `createEventPublisher` e `PluginEventError`: a parte dos eventos, exposta para quem monta o próprio servidor.

### Anotações MCP [proposta]

O `servePlugin` anota cada ferramenta a partir dos `effects` do manifesto, e a suíte de conformidade confere que elas concordam: `read` vira `readOnlyHint: true`; `external_write` vira `destructiveHint: true`; `network` e `external_write` viram `openWorldHint: true`. A descrição da ferramenta é a do manifesto, ou a do código, ou o nome.

### A pasta do projeto [proposta]

O daemon sobe **um processo por plugin e por projeto** (N238), e o `cwd` do manifesto é relativo à pasta do plugin (é onde está o `dist/`). Por isso o projeto chega pela variável de ambiente **`OTHEATER_PROJECT_DIR`**, que deve ser um caminho absoluto. Sem a variável, vale o `cwd` do processo (útil à mão); um valor vazio ou relativo é erro. Quem lê é `pluginProjectDirectory()`. O daemon precisa pôr essa variável no ambiente mínimo do plugin (trabalho do P8/P13; o P9 não mexe no daemon).

## Eventos

O plugin publica evento com `emit(name, payload)` dentro de uma ferramenta (ou com `servePlugin(...).events.publish`). O contrato com o daemon, que o P8 implementa, é:

- Método da notificação MCP: **`notifications/otheater/event`** [proposta].
- `params`: `{ "name": string, "payload": { ... } }`.
- `name` é o nome **declarado em `events:` do manifesto, sem o prefixo**. O daemon o publica como `plugin.<id>.<name>`.
- `payload` é um objeto JSON. Limite de **16 KB** (16 384 bytes do JSON), o padrão de `plugins.event_max_bytes` do P8. O limite do SDK é uma cortesia: o daemon continua sendo quem impõe o limite configurado.
- O ajudante **recusa no lado do plugin** um nome não declarado, um payload que não é objeto, um payload que não é JSON (circular, BigInt) e um payload acima do limite. A recusa é um `PluginEventError` (`undeclared`, `invalid_payload` ou `too_large`); nada é enviado. Dentro de uma ferramenta, o erro volta ao chamador como resultado com `isError`.

## Suíte de conformidade

`describePluginConformance(nome, fábrica)` (em `@otheater/sdk`) registra testes do Vitest no molde das suítes de `src/conformance`: a fábrica devolve um `PluginHarness` novo a cada teste, e o `dispose` o limpa. Ela sobe o servidor por stdio como o daemon faz e confere:

1. o manifesto é válido pelo validador do core;
2. o servidor responde ao `initialize` e não escreve nada além de protocolo no stdout;
3. o `tools/list` tem exatamente as ferramentas do manifesto (nem a mais, nem a menos, sem repetição);
4. cada ferramenta tem descrição e esquema de argumentos do tipo objeto;
5. as anotações concordam com os `effects`;
6. cada chamada de `calls` responde (ou volta como erro, se `isError`) e só publica eventos declarados, com payload objeto de até 16 KB e, se `emits`, os eventos esperados;
7. uma ferramenta que não existe é recusada;
8. o processo termina quando o stdin fecha.

Como a suíte sobe o processo de verdade, o `dist/` do plugin tem de existir (`pnpm build` antes). Para escrever outras checagens há também `PluginStdioClient`, o cliente stdio mínimo que a suíte usa (`listTools`, `callTool`, `notificationsOf`, `close`).

## O exemplo completo: `examples/plugin-notes`

Notas do projeto num arquivo JSON da pasta do projeto, sem rede e sem dependência além do SDK e do zod. O arquivo é `<projeto>/.plugin-notes.json` [proposta]; é lido inteiro a cada chamada (limite de 1000 notas de 2000 caracteres) e regravado por arquivo temporário mais `rename`. As chamadas de um processo são serializadas, então dois `add_note` seguidos nunca repetem o id.

| Ferramenta | Quem vê | Efeito | Observação |
| --- | --- | --- | --- |
| `list_notes` | ninguém (só o painel) | `read` | alimenta o painel `table` |
| `add_note` | `actor` | `local_write` | publica `note_added` com `{ id, length }` |
| `clear_notes` | ninguém (só o painel) | `local_write` | `requires_producer_approval`; o painel `action` a chama |

O formato de linha de `list_notes` (um array de `{ id, text, created_at }`) é **[proposta]** para o painel `table` do P10 adotar.

### `plugin.yaml`

```yaml
# plugin.yaml of the example plugin (Phase 9, P9; decision N240 (a)): notes of the project in a JSON
# file of the project folder, with no network and no dependency besides the SDK. The format is
# described by docs/reference/plugin-manifest.schema.json.
manifest_version: 1
id: notes
version: 1.0.0
description: Notes of the project, kept in a JSON file in the project folder.
server:
  type: stdio
  command: ['node', 'dist/server.js']
tools:
  # Read by the panel only: no role sees it, so the panel is its one caller.
  - name: list_notes
    roles: []
    effects: read
    description: Lists the notes of the project, oldest first.
  # The Actor writes a note of the project; the write is local (one JSON file of the project).
  - name: add_note
    roles: [actor]
    effects: local_write
    description: Adds a note to the project and returns it.
  # Erases every note: the Producer approves each call, and the panel is the one caller.
  - name: clear_notes
    roles: []
    effects: local_write
    requires_producer_approval: true
    description: Deletes every note of the project and returns how many were deleted.
events: [note_added]
panel:
  - type: table
    title: panel.notes
    source: list_notes
    columns:
      - { key: id, label: column.id }
      - { key: text, label: column.text }
      - { key: created_at, label: column.created_at }
  - type: action
    label: action.clear
    tool: clear_notes
i18n:
  en:
    panel.notes: Notes
    column.id: '#'
    column.text: Note
    column.created_at: Created
    action.clear: Delete all notes
  pt-BR:
    panel.notes: Notas
    column.id: '#'
    column.text: Nota
    column.created_at: Criada em
    action.clear: Apagar todas as notas
```

### `src/plugin.ts`

```ts
import { definePlugin, pluginTool, readPluginManifest } from '@otheater/sdk/plugin';
import { z } from 'zod';
import { MAX_NOTE_CHARS, NotesStore } from './notes.js';

/** The `plugin.yaml` of this package: `dist/plugin.js` is one level below it. */
export const MANIFEST_URL = new URL('../plugin.yaml', import.meta.url);

/**
 * The plugin, over the notes of `projectDir`. The manifest says what the tools are (roles,
 * effects, approval); this says what they do. `definePlugin` refuses the pair if they disagree.
 */
export function notesPlugin(projectDir: string, now?: () => Date) {
  const store = new NotesStore(projectDir, now);
  return definePlugin({
    manifest: readPluginManifest(MANIFEST_URL),
    tools: {
      list_notes: pluginTool({
        handler: () => store.list(),
      }),
      add_note: pluginTool({
        input: z.object({
          text: z.string().trim().min(1).max(MAX_NOTE_CHARS).describe('The text of the note.'),
        }),
        handler: async ({ text }, { emit }) => {
          const note = await store.add(text);
          await emit('note_added', { id: note.id, length: note.text.length });
          return note;
        },
      }),
      clear_notes: pluginTool({
        handler: async () => ({ deleted: await store.clear() }),
      }),
    },
  });
}
```

### `src/server.ts`

```ts
import { pluginProjectDirectory, servePlugin } from '@otheater/sdk/plugin';
import { notesPlugin } from './plugin.js';

// The entry of the server: `node dist/server.js`, as the manifest says. The project folder comes
// from OTHEATER_PROJECT_DIR, which the daemon sets; by hand it is the current folder.
servePlugin(notesPlugin(pluginProjectDirectory()));
```

O `package.json` do exemplo manda `dist` e `plugin.yaml` no pacote (N236: nenhum script de ciclo de vida roda na instalação, então o `dist` já vai pronto); o `pnpm build` da raiz gera o `dist` por `tsc -b`.

### Testes do exemplo

- `plugin.test.ts`: o `plugin.yaml` passa no validador do P3 (a mesma validação da instalação do P4), com a matriz de papéis, efeitos e aprovação, o painel e os catálogos `en` e `pt-BR` com as mesmas chaves;
- `notes.test.ts`: o armazenamento (ids, simultaneidade, limite, arquivo corrompido);
- `conformance.test.ts`: `describePluginConformance` sobre `dist/server.js`, mais chamadas reais por stdio, o evento `note_added`, o recuo para o `cwd` e a recusa de `OTHEATER_PROJECT_DIR` relativo.

## O que ficou de fora

- **Instalar o exemplo pelo P4** (`otheater plugin install`) fica para o **P13**, porque o P4 corre em paralelo a este passo. O P9 só garante o `plugin.yaml` válido pelo validador do P3, com teste.
- O lado do daemon dos eventos (ler `notifications/otheater/event`, aplicar `plugins.event_max_bytes`, publicar `plugin.<id>.<name>`) é do P8; o painel é do P10.
