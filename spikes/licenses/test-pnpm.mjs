// Teste do adaptador de pnpm-lock.yaml (sem rede: o cache do registro e montado aqui).
// Rode: node test-pnpm.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lerYamlDocumentos } from './lockfile-pnpm.mjs'
import { verificar } from './check.mjs'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'otheater-pnpm-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('YAML minimo: documentos, chaves entre aspas, mapas e listas em linha, lista em bloco', () => {
  const docs = lerYamlDocumentos(`---
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      '@s/a':
        specifier: ^1.0.0
        version: 1.0.0(x@2.0.0)
packages:
  '@s/a@1.0.0':
    resolution: {integrity: sha512-abc==}
    engines: {node: '>=10'}
    cpu: [arm64, x64]
    deprecated: 'texto: com dois pontos'
snapshots:
  '@s/a@1.0.0(x@2.0.0)': {}
ignoredOptionalDependencies:
  - y
---
lockfileVersion: '9.0'
`)
  assert.equal(docs.length, 2)
  const d = docs[0]
  assert.equal(d.lockfileVersion, '9.0')
  assert.equal(d.importers['.'].dependencies['@s/a'].version, '1.0.0(x@2.0.0)')
  assert.deepEqual(d.packages['@s/a@1.0.0'].cpu, ['arm64', 'x64'])
  assert.equal(d.packages['@s/a@1.0.0'].engines.node, '>=10')
  assert.equal(d.packages['@s/a@1.0.0'].resolution.integrity, 'sha512-abc==')
  assert.equal(d.packages['@s/a@1.0.0'].deprecated, 'texto: com dois pontos')
  assert.deepEqual(d.snapshots['@s/a@1.0.0(x@2.0.0)'], {})
  assert.deepEqual(d.ignoredOptionalDependencies, ['y'])
})

test('YAML minimo: escalar em bloco e recusado', () => {
  assert.throws(() => lerYamlDocumentos('a: |\n  texto\n'))
})

// Lockfile sintetico: raiz -> a (duas variantes de peers) -> peerdep; dev: lint -> gplzinha (GPL). packages/app -> link para packages/lib -> b (alias de b-real) e lgpl (LGPL-3.0, prod).
const LOCK = `---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0(peerdep@1.0.0)
    devDependencies:
      lint:
        specifier: ^1.0.0
        version: 1.0.0

  packages/app:
    dependencies:
      lib:
        specifier: workspace:*
        version: link:../lib
      a:
        specifier: ^1.0.0
        version: 1.0.0(peerdep@1.0.0)

  packages/lib:
    dependencies:
      b:
        specifier: npm:b-real@^2.0.0
        version: b-real@2.0.0
      lgpl:
        specifier: ^3.0.0
        version: 3.0.0

packages:

  a@1.0.0:
    resolution: {integrity: sha512-aaa}

  peerdep@1.0.0:
    resolution: {integrity: sha512-ppp}

  lint@1.0.0:
    resolution: {integrity: sha512-lll}

  gplzinha@1.0.0:
    resolution: {integrity: sha512-ggg}

  b-real@2.0.0:
    resolution: {integrity: sha512-bbb}

  lgpl@3.0.0:
    resolution: {integrity: sha512-lgp}

snapshots:

  a@1.0.0(peerdep@1.0.0):
    dependencies:
      peerdep: 1.0.0

  a@1.0.0(peerdep@1.0.0)(x@1.0.0):
    dependencies:
      peerdep: 1.0.0

  peerdep@1.0.0: {}

  lint@1.0.0:
    dependencies:
      gplzinha: 1.0.0

  gplzinha@1.0.0: {}

  b-real@2.0.0: {}

  lgpl@3.0.0: {}
`

function montar(nome) {
  const base = path.join(tmp, nome)
  const cache = path.join(base, 'cache')
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(base, 'pnpm-lock.yaml'), LOCK)
  const lic = { a: 'MIT', peerdep: 'ISC', lint: 'MIT', gplzinha: 'GPL-3.0-only', 'b-real': 'Apache-2.0', lgpl: 'LGPL-3.0' }
  for (const [n, l] of Object.entries(lic)) {
    const v = { a: '1.0.0', peerdep: '1.0.0', lint: '1.0.0', gplzinha: '1.0.0', 'b-real': '2.0.0', lgpl: '3.0.0' }[n]
    fs.writeFileSync(path.join(cache, `${n}@${v}.json`), JSON.stringify({ status: 200, nome: n, versao: v, license: l }))
  }
  const out = path.join(base, 'out')
  const r = spawnSync(process.execPath, [path.join(AQUI, 'lockfile-pnpm.mjs'), '--lock', path.join(base, 'pnpm-lock.yaml'), '--out', out, '--cache', cache, '--offline'], { encoding: 'utf8' })
  return { r, out }
}

test('adaptador + verificador: prod x dev, alias, link do monorepo e variantes de peers', async () => {
  const { r, out } = montar('e2e')
  assert.equal(r.status, 0, r.stderr)
  const analise = JSON.parse(fs.readFileSync(path.join(out, 'analise.json'), 'utf8'))
  assert.equal(analise.contagem.importers, 3)
  assert.equal(analise.contagem.pacotesAlcancaveis, 6, 'as duas variantes de a viram um pacote so')
  assert.equal(analise.contagem.producao, 4)
  assert.equal(analise.contagem.dev, 1 + 1, 'lint e gplzinha so entram por devDependencies')
  const prod = await verificar({ dir: out, soLockfile: true, politica: path.join(AQUI, 'policy.json') })
  assert.equal(prod.resumo.total, 4, 'a, peerdep, b-real, lgpl')
  assert.deepEqual(prod.falhas.map((f) => f.nome), ['lgpl'])
  assert.match(prod.falhas[0].caminho, /ws-packages--lib.*lgpl@3\.0\.0/)
  assert.equal(prod.itens.find((i) => i.nome === 'b-real').versao, '2.0.0', 'o alias aponta para o nome real')
  const tudo = await verificar({ dir: out, soLockfile: true, tudo: true, politica: path.join(AQUI, 'policy.json') })
  assert.equal(tudo.resumo.total, 6)
  const g = tudo.itens.find((i) => i.nome === 'gplzinha')
  assert.equal(g.escopo, 'dev')
  assert.equal(g.situacao, 'proibida')
  assert.equal(tudo.itens.find((i) => i.nome === 'lint').escopo, 'dev')
  assert.deepEqual(tudo.falhas.map((f) => f.nome).sort(), ['gplzinha', 'lgpl'])
})

test('adaptador: pacote sem metadado no cache entra como UNKNOWN (sem decisao), nunca some', async () => {
  const { r, out } = montar('semmeta')
  assert.equal(r.status, 0, r.stderr)
  fs.rmSync(path.join(tmp, 'semmeta', 'cache', 'peerdep@1.0.0.json'))
  const r2 = spawnSync(process.execPath, [path.join(AQUI, 'lockfile-pnpm.mjs'), '--lock', path.join(tmp, 'semmeta', 'pnpm-lock.yaml'), '--out', out, '--cache', path.join(tmp, 'semmeta', 'cache'), '--offline'], { encoding: 'utf8' })
  assert.equal(r2.status, 0, r2.stderr)
  const analise = JSON.parse(fs.readFileSync(path.join(out, 'analise.json'), 'utf8'))
  assert.equal(analise.semMetadadoNoRegistro.length, 1)
  const prod = await verificar({ dir: out, soLockfile: true, politica: path.join(AQUI, 'policy.json') })
  assert.equal(prod.itens.find((i) => i.nome === 'peerdep').situacao, 'sem-decisao')
})
