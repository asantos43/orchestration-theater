// Teste do verificador com uma arvore sintetica (sem rede, sem npm install).
// Rode: node test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verificar } from './check.mjs'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const BASE = JSON.parse(fs.readFileSync(path.join(AQUI, 'policy.json'), 'utf8'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'otheater-lic-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function pacote(raiz, nome, versao, licenca, extra = {}) {
  const pasta = path.join(raiz, 'node_modules', ...nome.split('/'))
  fs.mkdirSync(pasta, { recursive: true })
  const pj = { name: nome, version: versao, ...extra }
  if (licenca !== undefined) pj.license = licenca
  fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify(pj))
  return pasta
}

// raiz -> a (MIT) -> b (Apache-2.0); raiz -> dev1 (GPL-3.0, so dev)
function arvore(nome, pacotes, deps, devDeps = {}) {
  const raiz = path.join(tmp, nome)
  fs.mkdirSync(raiz, { recursive: true })
  fs.writeFileSync(
    path.join(raiz, 'package.json'),
    JSON.stringify({ name: nome, version: '1.0.0', private: true, dependencies: deps, devDependencies: devDeps }),
  )
  for (const [n, v, l, extra] of pacotes) pacote(raiz, n, v, l, extra)
  return raiz
}

function politica(nome, alteracoes = {}) {
  const arq = path.join(tmp, `politica-${nome}.json`)
  fs.writeFileSync(arq, JSON.stringify({ ...BASE, ...alteracoes }))
  return arq
}

const achar = (r, nome) => r.itens.find((i) => i.nome === nome)

test('so licencas permitidas: aprova', async () => {
  const dir = arvore(
    'ok',
    [
      ['a', '1.0.0', 'MIT', { dependencies: { b: '1.0.0' } }],
      ['b', '1.0.0', 'Apache-2.0'],
    ],
    { a: '1.0.0' },
  )
  const r = await verificar({ dir, politica: politica('ok') })
  assert.equal(r.falhas.length, 0)
  assert.equal(achar(r, 'b').situacao, 'permitida')
})

test('GPL, AGPL e LGPL reprovam e mostram quem trouxe', async () => {
  const dir = arvore(
    'proibidas',
    [
      ['a', '1.0.0', 'MIT', { dependencies: { b: '1.0.0', c: '1.0.0' } }],
      ['b', '1.0.0', 'GPL-3.0-only'],
      ['c', '1.0.0', 'AGPL-3.0-or-later'],
      ['d', '1.0.0', 'LGPL-2.1-or-later'],
    ],
    { a: '1.0.0', d: '1.0.0' },
  )
  const r = await verificar({ dir, politica: politica('proibidas') })
  assert.deepEqual(r.falhas.map((f) => f.nome).sort(), ['b', 'c', 'd'])
  assert.ok(achar(r, 'b').caminho.includes('a@1.0.0 > b@1.0.0'))
  assert.equal(achar(r, 'b').situacao, 'proibida')
})

test('OR escolhe o melhor ramo; AND vale o pior', async () => {
  const dir = arvore(
    'spdx',
    [
      ['ou', '1.0.0', '(MIT OR GPL-3.0-only)'],
      ['e', '1.0.0', 'MIT AND LGPL-2.1-or-later'],
      ['ou2', '1.0.0', '(GPL-2.0-only OR AGPL-3.0-only)'],
    ],
    { ou: '1.0.0', e: '1.0.0', ou2: '1.0.0' },
  )
  const r = await verificar({ dir, politica: politica('spdx') })
  assert.equal(achar(r, 'ou').situacao, 'permitida')
  assert.equal(achar(r, 'e').situacao, 'proibida')
  assert.equal(achar(r, 'ou2').situacao, 'proibida')
})

test('licenca fora da lista ou desconhecida fica sem decisao e reprova', async () => {
  const dir = arvore(
    'semdecisao',
    [
      ['u', '1.0.0', 'Unlicense'],
      ['x', '1.0.0', undefined],
      ['c', '1.0.0', 'SEE LICENSE IN LICENSE.md'],
      ['inv', '1.0.0', 'Licenca Qualquer 3'],
    ],
    { u: '1.0.0', x: '1.0.0', c: '1.0.0', inv: '1.0.0' },
  )
  const r = await verificar({ dir, politica: politica('semdecisao') })
  assert.equal(r.falhas.length, 4)
  for (const n of ['u', 'x', 'c', 'inv']) assert.equal(achar(r, n).situacao, 'sem-decisao', n)
})

test('palpite de licenca (MIT*) reprova por padrao e vira aviso com --palpite=aviso', async () => {
  const dir = arvore('palpite', [['p', '1.0.0', undefined]], { p: '1.0.0' })
  fs.writeFileSync(
    path.join(dir, 'node_modules', 'p', 'LICENSE'),
    'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software\n',
  )
  const pol = politica('palpite')
  const duro = await verificar({ dir, politica: pol })
  assert.equal(duro.falhas.length, 1)
  assert.match(achar(duro, 'p').licenca, /\*$/)
  const mole = await verificar({ dir, politica: pol, palpite: 'aviso' })
  assert.equal(mole.falhas.length, 0)
})

test('decisao por licenca vale para toda a arvore', async () => {
  const dir = arvore('decisao', [['bo', '1.0.0', 'BlueOak-1.0.0']], { bo: '1.0.0' })
  const pol = politica('decisao', {
    decisoesPorLicenca: [
      { licenca: 'BlueOak-1.0.0', decisao: 'aceita', decididoPor: 'teste', data: '2026-11-15', motivo: 'teste', fonte: 'teste' },
    ],
  })
  const r = await verificar({ dir, politica: pol })
  assert.equal(r.falhas.length, 0)
  assert.equal(achar(r, 'bo').situacao, 'decidida')
})

test('decisao nunca libera licenca proibida', async () => {
  const dir = arvore('nuncalibera', [['g', '1.0.0', 'GPL-3.0-only']], { g: '1.0.0' })
  const pol = politica('nuncalibera', {
    decisoesPorLicenca: [
      { licenca: 'GPL-3.0-only', decisao: 'aceita', decididoPor: 'teste', data: '2026-11-15', motivo: 'x', fonte: 'x' },
    ],
  })
  const r = await verificar({ dir, politica: pol })
  assert.equal(achar(r, 'g').situacao, 'proibida')
  assert.equal(r.falhas.length, 1)
})

test('excecao por pacote respeita nome, versao, licenca exata e escopo', async () => {
  const dir = arvore('excecao', [['custom', '1.2.0', 'SEE LICENSE IN LICENSE.md']], { custom: '1.2.0' })
  // o texto exato que o verificador le (o license-checker pode reescrever "SEE LICENSE IN")
  const lido = achar(await verificar({ dir, politica: politica('exc-0') }), 'custom').licenca
  const exc = (extra = {}) => ({
    pacote: 'custom',
    versoes: '>=1.0.0 <2.0.0',
    licenca: lido,
    escopo: 'producao',
    decisao: 'aceita',
    decididoPor: 'teste',
    data: '2026-11-15',
    motivo: 'teste',
    fonte: 'teste',
    ...extra,
  })
  const ok = await verificar({ dir, politica: politica('exc-ok', { excecoes: [exc()] }) })
  assert.equal(ok.falhas.length, 0)
  assert.equal(achar(ok, 'custom').situacao, 'decidida')
  for (const [rotulo, extra] of [
    ['versao fora da faixa', { versoes: '>=2.0.0' }],
    ['licenca diferente', { licenca: 'MIT' }],
    ['escopo dev', { escopo: 'dev' }],
    ['outro pacote', { pacote: 'outro' }],
  ]) {
    const r = await verificar({ dir, politica: politica('exc-no', { excecoes: [exc(extra)] }) })
    assert.equal(r.falhas.length, 1, rotulo)
  }
})

test('escopo: dependencia so de dev nao reprova em producao, reprova com --tudo', async () => {
  const dir = arvore('escopo', [['a', '1.0.0', 'MIT'], ['d', '1.0.0', 'GPL-3.0-only']], { a: '1.0.0' }, { d: '1.0.0' })
  const pol = politica('escopo')
  const prod = await verificar({ dir, politica: pol })
  assert.equal(prod.falhas.length, 0)
  assert.equal(achar(prod, 'd'), undefined)
  const tudo = await verificar({ dir, politica: pol, tudo: true })
  assert.equal(tudo.falhas.length, 1)
  assert.equal(achar(tudo, 'd').escopo, 'dev')
})

test('alerta de arquivo de licenca copyleft dentro de pacote que declara outra licenca', async () => {
  const dir = arvore('alerta', [['bin', '1.0.0', 'Apache-2.0']], { bin: '1.0.0' })
  const lic = path.join(dir, 'node_modules', 'bin', 'vendor', 'licenses')
  fs.mkdirSync(lic, { recursive: true })
  fs.writeFileSync(path.join(lic, 'LGPL-2.1.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\n')
  const aviso = await verificar({ dir, politica: politica('alerta') })
  assert.equal(aviso.falhas.length, 0)
  assert.equal(aviso.alertas.length, 1)
  assert.match(aviso.alertas[0].alertas.join(' '), /LGPL-2\.1\.txt/)
  const duro = await verificar({ dir, politica: politica('alerta'), alertas: 'falha' })
  assert.equal(duro.falhas.length, 1)
})

test('CLI: codigo de saida 0 quando aprova, 1 quando reprova, 2 em uso errado', () => {
  const rodar = (...args) => spawnSync(process.execPath, [path.join(AQUI, 'check.mjs'), ...args], { encoding: 'utf8' })
  const ok = rodar('--dir', path.join(tmp, 'ok'), '--quiet')
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const ruim = rodar('--dir', path.join(tmp, 'proibidas'), '--quiet')
  assert.equal(ruim.status, 1)
  const erro = rodar('--dir', path.join(tmp, 'nao-existe'), '--quiet')
  assert.equal(erro.status, 2)
})

test('excecao por pacote so libera licenca proibida com permiteProibida explicito', async () => {
  const dir = arvore('excproibida', [['g', '1.0.0', 'LGPL-2.1-or-later']], { g: '1.0.0' })
  const base = { pacote: 'g', licenca: 'LGPL-2.1-or-later', escopo: 'producao', decisao: 'aceita', decididoPor: 'teste', data: '2026-11-15', motivo: 'teste', fonte: 'teste' }
  const sem = await verificar({ dir, politica: politica('ep-sem', { excecoes: [base] }) })
  assert.equal(sem.falhas.length, 1)
  const com = await verificar({ dir, politica: politica('ep-com', { excecoes: [{ ...base, permiteProibida: true }] }) })
  assert.equal(com.falhas.length, 0)
  assert.equal(achar(com, 'g').situacao, 'decidida')
})
