#!/usr/bin/env node
// Spike da Fase 0: adaptador de pnpm-lock.yaml para o formato que o check.mjs le (package-lock.json v3).
//
// Uso:
//   node lockfile-pnpm.mjs --lock <pnpm-lock.yaml> --out <pasta de saida> --cache <pasta de cache>
//                          [--ws-raiz <pasta do repo, para ler os package.json dos pacotes>]
//                          [--concorrencia 4] [--offline] [--registro https://registry.npmjs.org]
//   depois: node check.mjs --dir <pasta de saida> --so-lockfile --tudo [--nivel-c=...] [--json <arquivo>]
//
// O que faz:
//   1. Le o pnpm-lock.yaml (lockfileVersion 9.0, com o documento extra do pnpm 11 que descreve o proprio pnpm;
//      esse documento e ignorado e contado a parte). Parser YAML minimo, so para este formato. Sem dependencias.
//   2. Para cada pacote@versao alcancavel a partir dos `importers`, busca a licenca em
//      GET <registro>/<pacote>/<versao> (so JSON, sem tarball), com cache em disco e concorrencia baixa.
//   3. Grava <saida>/package.json e <saida>/package-lock.json (v3) sinteticos, para o Arborist e o check.mjs lerem:
//        - raiz: dependencies = um no sintetico por pacote do monorepo (as dependencias de producao dele)
//                devDependencies = outro no sintetico por pacote (as devDependencies dele);
//          os nos sinteticos sao `private`, entao o verificador nao os conta como pacotes de terceiros;
//        - cada nome@versao ocupa um unico lugar (`node_modules/<apelido>`, com `name` real), para o verificador nao ver copias duplicadas.
//   4. Grava <saida>/analise.json: alcance exato de producao x dev calculado aqui (por variante de peers),
//      pacotes sem metadado no registro, variantes de peers que divergem, licenca dos package.json do monorepo.
//
// Seguranca: nao executa nada do repositorio medido, nao instala, nao baixa tarball. Trata o lockfile como dado.
// Saida: 0 = ok; 2 = erro.

import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as dormir } from 'node:timers/promises'

// ---------- argumentos ----------
function lerArgs(argv) {
  const a = { lock: null, out: null, cache: null, wsRaiz: null, concorrencia: 4, offline: false, registro: 'https://registry.npmjs.org' }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--lock') a.lock = argv[++i]
    else if (v === '--out') a.out = argv[++i]
    else if (v === '--cache') a.cache = argv[++i]
    else if (v === '--ws-raiz') a.wsRaiz = argv[++i]
    else if (v === '--concorrencia') a.concorrencia = Number(argv[++i])
    else if (v === '--registro') a.registro = argv[++i].replace(/\/$/, '')
    else if (v === '--offline') a.offline = true
    else if (v === '-h' || v === '--help') a.ajuda = true
    else throw new Error(`argumento desconhecido: ${v}`)
  }
  if (!a.ajuda && (!a.lock || !a.out || !a.cache)) throw new Error('faltam --lock, --out e --cache')
  if (!(a.concorrencia >= 1 && a.concorrencia <= 8)) throw new Error('--concorrencia vai de 1 a 8 (o pedido e concorrencia baixa)')
  return a
}

// ---------- YAML minimo (so o que o pnpm-lock.yaml usa) ----------
// Suporta: mapas por indentacao, listas `- x`, escalares planos e entre aspas, mapas `{a: b}` e listas `[a, b]` em linha.
// Nao suporta: ancoras, tags, escalares em bloco (`|`, `>`). Lanca erro se encontrar.
function lerAspas(s, i) {
  const q = s[i]
  let out = ''
  i++
  while (i < s.length) {
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      return [out, i + 1]
    }
    if (q === '"' && s[i] === '\\') {
      const c = s[i + 1]
      out += { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' }[c] ?? c
      i += 2
      continue
    }
    out += s[i++]
  }
  throw new Error(`aspas sem fechar: ${s.slice(0, 60)}`)
}

function escalar(t) {
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null' || t === '~') return null
  return t
}

// Valor em linha (flow). Devolve [valor, proximoIndice].
function lerFlow(s, i) {
  while (s[i] === ' ') i++
  if (s[i] === '{') {
    const o = {}
    i++
    for (;;) {
      while (s[i] === ' ') i++
      if (s[i] === '}') return [o, i + 1]
      let k
      if (s[i] === "'" || s[i] === '"') [k, i] = lerAspas(s, i)
      else {
        const j = s.slice(i).search(/:(?: |$)/)
        if (j < 0) throw new Error(`chave sem ':' em ${s}`)
        k = s.slice(i, i + j).trim()
        i += j
      }
      if (s[i] !== ':') throw new Error(`esperava ':' em ${s}`)
      i++
      let v
      ;[v, i] = lerFlow(s, i)
      o[k] = v
      while (s[i] === ' ') i++
      if (s[i] === ',') i++
    }
  }
  if (s[i] === '[') {
    const l = []
    i++
    for (;;) {
      while (s[i] === ' ') i++
      if (s[i] === ']') return [l, i + 1]
      let v
      ;[v, i] = lerFlow(s, i)
      l.push(v)
      while (s[i] === ' ') i++
      if (s[i] === ',') i++
    }
  }
  if (s[i] === "'" || s[i] === '"') return lerAspas(s, i)
  let j = i
  while (j < s.length && !(s[j] === ',' || s[j] === '}' || s[j] === ']')) j++
  return [escalar(s.slice(i, j).trim()), j]
}

function valorEmLinha(txt) {
  const t = txt.trim()
  if (/^[|>][-+]?$/.test(t)) throw new Error('escalar em bloco nao suportado')
  if (t.startsWith('{') || t.startsWith('[')) {
    const [v, fim] = lerFlow(t, 0)
    if (t.slice(fim).trim()) throw new Error(`lixo depois do valor: ${t}`)
    return v
  }
  if (t[0] === "'" || t[0] === '"') return lerAspas(t, 0)[0]
  return escalar(t)
}

function lerChave(s) {
  if (s[0] === "'" || s[0] === '"') {
    const [k, i] = lerAspas(s, 0)
    if (s[i] !== ':') throw new Error(`chave entre aspas sem ':' : ${s.slice(0, 80)}`)
    return [k, s.slice(i + 1)]
  }
  const j = s.search(/:(?: |$)/)
  if (j < 0) throw new Error(`linha sem chave: ${s.slice(0, 80)}`)
  return [s.slice(0, j), s.slice(j + 1)]
}

export function lerYamlDocumentos(texto) {
  const docs = []
  let atual = []
  for (const bruta of texto.split('\n')) {
    if (bruta === '---') {
      if (atual.length) docs.push(atual)
      atual = []
      continue
    }
    atual.push(bruta)
  }
  if (atual.length) docs.push(atual)
  return docs.map(parseDoc)
}

function parseDoc(linhasBrutas) {
  const L = []
  for (const l of linhasBrutas) {
    if (!l.trim() || l.trimStart().startsWith('#')) continue
    const ind = l.length - l.trimStart().length
    L.push({ ind, txt: l.trim() })
  }
  let p = 0
  function bloco(ind) {
    if (L[p].txt.startsWith('- ') || L[p].txt === '-') return sequencia(ind)
    return mapa(ind)
  }
  function sequencia(ind) {
    const lista = []
    while (p < L.length && L[p].ind === ind && (L[p].txt.startsWith('- ') || L[p].txt === '-')) {
      const resto = L[p].txt.slice(1).trim()
      if (!resto) throw new Error('item de lista aninhado nao suportado')
      p++
      lista.push(valorEmLinha(resto))
    }
    return lista
  }
  function mapa(ind) {
    const o = {}
    while (p < L.length && L[p].ind === ind && !L[p].txt.startsWith('- ')) {
      const [k, resto] = lerChave(L[p].txt)
      p++
      if (resto.trim()) o[k] = valorEmLinha(resto)
      else if (p < L.length && L[p].ind > ind) o[k] = bloco(L[p].ind)
      else if (p < L.length && L[p].ind === ind && L[p].txt.startsWith('- ')) o[k] = sequencia(ind)
      else o[k] = null
    }
    return o
  }
  const raiz = L.length ? bloco(L[0].ind) : {}
  if (p < L.length) throw new Error(`YAML nao consumido por inteiro (linha ${p} de ${L.length}): ${L[p].txt.slice(0, 80)}`)
  return raiz
}

// ---------- nomes e versoes do pnpm ----------
// `pkg@1.0.0(peer@2.0.0)` -> { nome: 'pkg', versao: '1.0.0', peers: '(peer@2.0.0)' }
function separarChave(k) {
  const abre = k.indexOf('(')
  const base = abre < 0 ? k : k.slice(0, abre)
  const peers = abre < 0 ? '' : k.slice(abre)
  const i = base.lastIndexOf('@')
  if (i <= 0) throw new Error(`chave de pacote invalida: ${k}`)
  return { nome: base.slice(0, i), versao: base.slice(i + 1), peers, base }
}

// Valor de uma dependencia: `1.2.3(peers)`, `link:../x` ou alias `real@1.2.3(peers)`.
function alvoDaDependencia(nomeLocal, valor) {
  const v = String(valor)
  if (v.startsWith('link:')) return { tipo: 'link', caminho: v.slice(5) }
  if (/^\d/.test(v)) {
    const abre = v.indexOf('(')
    const versao = abre < 0 ? v : v.slice(0, abre)
    return { tipo: 'pacote', nome: nomeLocal, versao, snapshot: `${nomeLocal}@${v}`, alias: false }
  }
  const s = separarChave(v)
  return { tipo: 'pacote', nome: s.nome, versao: s.versao, snapshot: v, alias: true }
}

// ---------- registro npm ----------
function arquivoCache(cache, nome, versao) {
  return path.join(cache, `${nome.replace('/', '__')}@${versao}.json`)
}

async function buscarRegistro({ registro, cache, nome, versao, offline }) {
  const arq = arquivoCache(cache, nome, versao)
  if (fs.existsSync(arq)) return JSON.parse(fs.readFileSync(arq, 'utf8'))
  if (offline) return { status: 'sem-cache' }
  const url = `${registro}/${nome.startsWith('@') ? '@' + encodeURIComponent(nome.slice(1)) : encodeURIComponent(nome)}/${encodeURIComponent(versao)}`
  let ultimo = null
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'otheater-license-spike' } })
      if (r.status === 404) {
        const x = { status: 404, nome, versao, url }
        fs.writeFileSync(arq, JSON.stringify(x))
        return x
      }
      if (r.status === 429 || r.status >= 500) {
        ultimo = `HTTP ${r.status}`
        await dormir(1000 * 2 ** t)
        continue
      }
      if (!r.ok) {
        ultimo = `HTTP ${r.status}`
        break
      }
      const j = await r.json()
      // Guarda so o necessario (a resposta inteira pode ter centenas de KB).
      const x = { status: 200, nome: j.name, versao: j.version, license: j.license ?? null, licenses: j.licenses ?? null, deprecated: j.deprecated ?? null, repository: j.repository?.url ?? j.repository ?? null, url }
      fs.writeFileSync(arq, JSON.stringify(x))
      return x
    } catch (e) {
      ultimo = String(e.message ?? e)
      await dormir(1000 * 2 ** t)
    }
  }
  return { status: 'erro', erro: ultimo, url }
}

async function emLotes(itens, concorrencia, fn, progresso) {
  let i = 0
  let feitos = 0
  const trabalhadores = Array.from({ length: concorrencia }, async () => {
    while (i < itens.length) {
      const k = i++
      await fn(itens[k], k)
      feitos++
      if (progresso && feitos % 100 === 0) progresso(feitos, itens.length)
    }
  })
  await Promise.all(trabalhadores)
}

// Normaliza o campo license do registro para o que o check.mjs entende (string SPDX).
function licencaDoRegistro(m) {
  const um = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? (x.type ?? x.name ?? null) : null)
  if (m.license != null) {
    if (Array.isArray(m.license)) {
      const l = m.license.map(um).filter(Boolean)
      return l.length ? (l.length === 1 ? l[0] : `(${l.join(' OR ')})`) : null
    }
    return um(m.license)
  }
  if (Array.isArray(m.licenses)) {
    const l = m.licenses.map(um).filter(Boolean)
    return l.length ? (l.length === 1 ? l[0] : `(${l.join(' OR ')})`) : null
  }
  return null
}

// ---------- principal ----------
async function principal() {
  const a = lerArgs(process.argv.slice(2))
  if (a.ajuda) {
    console.log('Uso: node lockfile-pnpm.mjs --lock <pnpm-lock.yaml> --out <pasta> --cache <pasta> [--ws-raiz <pasta>] [--concorrencia 4] [--offline]')
    return
  }
  const lockPath = path.resolve(a.lock)
  const out = path.resolve(a.out)
  const cache = path.resolve(a.cache)
  const wsRaiz = path.resolve(a.wsRaiz ?? path.dirname(lockPath))
  fs.mkdirSync(out, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })

  const docs = lerYamlDocumentos(fs.readFileSync(lockPath, 'utf8'))
  // O documento do projeto e o que tem `snapshots` e `importers` com pacotes de verdade; o do pnpm tem `packageManagerDependencies`.
  const ehEnv = (d) => Object.values(d.importers ?? {}).some((i) => i.packageManagerDependencies)
  const env = docs.filter(ehEnv)
  const projeto = docs.filter((d) => !ehEnv(d))
  if (projeto.length !== 1) throw new Error(`esperava 1 documento do projeto, achei ${projeto.length}`)
  const lock = projeto[0]
  if (String(lock.lockfileVersion) !== '9.0') throw new Error(`lockfileVersion ${lock.lockfileVersion} nao suportada (so 9.0)`)
  const envPacotes = env.reduce((n, d) => n + Object.keys(d.packages ?? {}).length, 0)

  const importers = lock.importers ?? {}
  const pacotes = lock.packages ?? {} // chave: nome@versao
  const snapshots = lock.snapshots ?? {} // chave: nome@versao(peers)

  // ---- variantes de snapshot e dependencias ----
  const snap = new Map() // chave do snapshot -> { base, nome, versao, deps: [{nomeLocal, tipo, ...}], opcional }
  for (const [k, s] of Object.entries(snapshots)) {
    const sep = separarChave(k)
    const deps = []
    for (const [campo, tipo] of [['dependencies', 'prod'], ['optionalDependencies', 'opcional']]) {
      for (const [n, v] of Object.entries(s?.[campo] ?? {})) deps.push({ nomeLocal: n, tipo, alvo: alvoDaDependencia(n, v) })
    }
    snap.set(k, { chave: k, base: sep.base, nome: sep.nome, versao: sep.versao, deps, opcional: s?.optional === true })
  }
  const semPacote = []
  for (const s of snap.values()) if (!pacotes[s.base]) semPacote.push(s.chave)

  // ---- importers ----
  const imp = new Map() // id -> { id, prod: [dep], dev: [dep] }
  for (const [id, i] of Object.entries(importers)) {
    const r = { id, prod: [], dev: [] }
    for (const [campo, lista] of [['dependencies', r.prod], ['optionalDependencies', r.prod], ['devDependencies', r.dev]]) {
      for (const [n, d] of Object.entries(i[campo] ?? {})) {
        const alvo = alvoDaDependencia(n, d.version)
        if (alvo.tipo === 'link') alvo.importer = path.posix.normalize(path.posix.join(id, alvo.caminho))
        lista.push({ nomeLocal: n, tipo: campo === 'optionalDependencies' ? 'opcional' : 'prod', specifier: d.specifier, alvo })
      }
    }
    imp.set(id, r)
  }
  const linksSemImporter = []
  for (const r of imp.values()) for (const d of [...r.prod, ...r.dev]) if (d.alvo.tipo === 'link' && !imp.has(d.alvo.importer)) linksSemImporter.push(`${r.id} -> ${d.alvo.caminho}`)

  // ---- alcance exato (por variante de peers), BFS com caminho ----
  // Chaves de no: `snap:<chave>` ou `imp:<id>`.
  function arestasDe(no, comDev) {
    if (no.startsWith('imp:')) {
      const r = imp.get(no.slice(4))
      return [...r.prod, ...(comDev ? r.dev : [])].map((d) => ({ para: d.alvo.tipo === 'link' ? `imp:${d.alvo.importer}` : `snap:${d.alvo.snapshot}`, via: d }))
    }
    const s = snap.get(no.slice(5))
    if (!s) return []
    return s.deps.map((d) => ({ para: d.alvo.tipo === 'link' ? `imp:${d.alvo.importer}` : `snap:${d.alvo.snapshot}`, via: d }))
  }
  function bfs(comDev) {
    const pai = new Map()
    const fila = []
    for (const id of imp.keys()) {
      pai.set(`imp:${id}`, null)
      fila.push(`imp:${id}`)
    }
    while (fila.length) {
      const n = fila.shift()
      for (const { para } of arestasDe(n, comDev)) {
        if (pai.has(para)) continue
        pai.set(para, n)
        fila.push(para)
      }
    }
    return pai
  }
  const paiProd = bfs(false)
  const paiTudo = bfs(true)
  const nomeNo = (n) => (n.startsWith('imp:') ? `[${n.slice(4)}]` : n.slice(5))
  const caminhoExato = (n, pai) => {
    const p = []
    for (let x = n; x; x = pai.get(x)) p.push(nomeNo(x))
    return p.reverse().join(' > ')
  }
  const chavesProd = new Set()
  const chavesTudo = new Set()
  for (const n of paiProd.keys()) if (n.startsWith('snap:') && snap.has(n.slice(5))) chavesProd.add(snap.get(n.slice(5)).base)
  for (const n of paiTudo.keys()) if (n.startsWith('snap:') && snap.has(n.slice(5))) chavesTudo.add(snap.get(n.slice(5)).base)
  const naoAlcancaveis = Object.keys(pacotes).filter((k) => !chavesTudo.has(k))

  // ---- licencas no registro ----
  const lista = [...chavesTudo].sort().map((k) => ({ chave: k, ...separarChave(k) }))
  const meta = new Map()
  let feitosRede = 0
  await emLotes(
    lista,
    a.concorrencia,
    async (p) => {
      const arq = arquivoCache(cache, p.nome, p.versao)
      if (!fs.existsSync(arq)) feitosRede++
      meta.set(p.chave, await buscarRegistro({ registro: a.registro, cache, nome: p.nome, versao: p.versao, offline: a.offline }))
    },
    (f, t) => console.error(`  registro: ${f}/${t}`),
  )
  const semMetadado = []
  const licencaDe = new Map()
  for (const p of lista) {
    const m = meta.get(p.chave)
    if (m.status !== 200) {
      semMetadado.push({ pacote: p.chave, status: m.status, erro: m.erro ?? null })
      licencaDe.set(p.chave, 'UNKNOWN')
      continue
    }
    licencaDe.set(p.chave, licencaDoRegistro(m) ?? 'UNKNOWN')
  }

  // ---- fusao das variantes por nome@versao ----
  // Cada variante de peers vira um snapshot; aqui elas viram um no so por nome@versao, com a UNIAO das dependencias.
  // A uniao pode so aumentar o alcance (nunca perde um pacote); o alcance exato por variante esta em `analise.json`.
  const fundido = new Map() // base -> { nome, versao, deps: Map(baseAlvo -> {tipo, alvo}) }
  const diferemEntreVariantes = new Set()
  for (const s of snap.values()) {
    if (!chavesTudo.has(s.base)) continue
    let f = fundido.get(s.base)
    if (!f) fundido.set(s.base, (f = { nome: s.nome, versao: s.versao, deps: new Map(), porNome: new Map() }))
    for (const d of s.deps) {
      if (d.alvo.tipo !== 'pacote') continue
      const baseAlvo = separarChave(d.alvo.snapshot).base
      const antes = f.porNome.get(d.nomeLocal)
      if (antes && antes !== baseAlvo) diferemEntreVariantes.add(`${s.base}: dependencia ${d.nomeLocal} aparece como ${antes} e ${baseAlvo} em variantes diferentes (entram as duas)`)
      f.porNome.set(d.nomeLocal, antes ?? baseAlvo)
      const ex = f.deps.get(baseAlvo)
      if (!ex) f.deps.set(baseAlvo, { tipo: d.tipo, baseAlvo, nomeLocal: d.nomeLocal, alvo: d.alvo })
      else if (ex.tipo === 'opcional' && d.tipo === 'prod') ex.tipo = 'prod'
    }
  }
  const conflitos = [...diferemEntreVariantes]
  // Dependencias que apontam para pacote fora de `packages` (ex.: ignoredOptionalDependencies) nao entram.
  const semAlvo = []
  for (const f of fundido.values()) {
    for (const [k, d] of [...f.deps]) {
      if (!pacotes[d.baseAlvo]) {
        semAlvo.push(`${f.nome}@${f.versao} -> ${d.nomeLocal} (${d.baseAlvo})`)
        f.deps.delete(k)
      }
    }
  }

  // ---- arvore sintetica ----
  // Cada nome@versao ocupa UM lugar so, em `node_modules/<apelido unico>`, e quem depende dele usa o apelido
  // (`"<apelido>": "npm:<nome real>@<versao>"`). Assim o verificador nunca ve duas copias do mesmo nome@versao
  // (ele classifica producao x dev pela primeira copia que acha) e nao ha conflito de hoisting.
  // Os pacotes do monorepo viram nos `private` (o verificador nao os conta): P(id) leva as dependencias de
  // producao do pacote, D(id) as devDependencies. A raiz depende de todos os P (dependencies) e de todos os D (devDependencies).
  const apelido = (base) => 'p-' + base.replace(/^@/, '').replace(/\//g, '__')
  const nomeP = (id) => `ws-${id === '.' ? 'raiz' : id.replace(/\//g, '--')}`
  const nomeD = (id) => `wsdev-${id === '.' ? 'raiz' : id.replace(/\//g, '--')}`
  const packagesLock = {}
  const raizDeps = {}
  const raizDevDeps = {}
  for (const r of imp.values()) {
    raizDeps[nomeP(r.id)] = '0.0.0'
    raizDevDeps[nomeD(r.id)] = '0.0.0'
    for (const [tipoNo, nome, lista2] of [['prod', nomeP(r.id), r.prod], ['dev', nomeD(r.id), r.dev]]) {
      const deps = {}
      const opt = {}
      for (const d of lista2) {
        if (d.alvo.tipo === 'link') {
          if (imp.has(d.alvo.importer)) deps[nomeP(d.alvo.importer)] = '0.0.0'
          continue
        }
        const base = separarChave(d.alvo.snapshot).base
        if (!pacotes[base]) continue
        ;(d.tipo === 'opcional' ? opt : deps)[apelido(base)] = `npm:${d.alvo.nome}@${d.alvo.versao}`
      }
      const e = { name: nome, version: '0.0.0', private: true }
      if (Object.keys(deps).length) e.dependencies = deps
      if (Object.keys(opt).length) e.optionalDependencies = opt
      packagesLock[`node_modules/${nome}`] = e
    }
  }
  for (const [base, f] of fundido) {
    const p = pacotes[base]
    const e = { name: f.nome, version: f.versao, license: licencaDe.get(base) }
    if (p?.os) e.os = p.os
    if (p?.cpu) e.cpu = p.cpu
    const deps = {}
    const opt = {}
    for (const d of f.deps.values()) (d.tipo === 'opcional' ? opt : deps)[apelido(d.baseAlvo)] = `npm:${separarChave(d.baseAlvo).nome}@${separarChave(d.baseAlvo).versao}`
    if (Object.keys(deps).length) e.dependencies = deps
    if (Object.keys(opt).length) e.optionalDependencies = opt
    packagesLock[`node_modules/${apelido(base)}`] = e
  }
  packagesLock[''] = { name: 'nimbalyst-medicao', version: '0.0.0', private: true, dependencies: raizDeps, devDependencies: raizDevDeps }
  const lockOut = { name: 'nimbalyst-medicao', version: '0.0.0', lockfileVersion: 3, requires: true, packages: packagesLock }
  fs.writeFileSync(path.join(out, 'package-lock.json'), JSON.stringify(lockOut, null, 1))
  fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'nimbalyst-medicao', version: '0.0.0', private: true, dependencies: raizDeps, devDependencies: raizDevDeps }, null, 1))

  // ---- licenca declarada nos package.json do monorepo (so leitura) ----
  const licencasWs = []
  for (const id of imp.keys()) {
    const arq = path.join(wsRaiz, id === '.' ? '' : id, 'package.json')
    if (!fs.existsSync(arq)) {
      licencasWs.push({ id, existe: false })
      continue
    }
    const pj = JSON.parse(fs.readFileSync(arq, 'utf8'))
    licencasWs.push({ id, nome: pj.name ?? null, versao: pj.version ?? null, license: pj.license ?? null, private: pj.private === true })
  }

  // ---- analise exata ----
  const itens = lista.map((p) => ({
    pacote: p.chave,
    licenca: licencaDe.get(p.chave),
    escopo: chavesProd.has(p.chave) ? 'producao' : 'dev',
    os: pacotes[p.chave]?.os ?? null,
    cpu: pacotes[p.chave]?.cpu ?? null,
    caminhoExato: caminhoExato(`snap:${[...snap.values()].find((s) => s.base === p.chave && (chavesProd.has(p.chave) ? paiProd : paiTudo).has(`snap:${s.chave}`))?.chave ?? p.chave}`, chavesProd.has(p.chave) ? paiProd : paiTudo),
  }))
  const porLic = (arr) => {
    const m = {}
    for (const i of arr) m[i.licenca] = (m[i.licenca] ?? 0) + 1
    return Object.fromEntries(Object.entries(m).sort((x, y) => y[1] - x[1]))
  }
  const analise = {
    fonte: { lock: path.basename(lockPath), lockfileVersion: lock.lockfileVersion, registro: a.registro },
    contagem: {
      importers: imp.size,
      pacotesNoLockfile: Object.keys(pacotes).length,
      snapshotsVariantes: snap.size,
      pacotesAlcancaveis: lista.length,
      producao: itens.filter((i) => i.escopo === 'producao').length,
      dev: itens.filter((i) => i.escopo === 'dev').length,
      naoAlcancaveis: naoAlcancaveis.length,
      documentoDoPnpm: { documentos: env.length, pacotesIgnorados: envPacotes },
      entradasNoLockSintetico: Object.keys(packagesLock).length,
      buscasNaRede: feitosRede,
    },
    licencasProducao: porLic(itens.filter((i) => i.escopo === 'producao')),
    licencasDev: porLic(itens.filter((i) => i.escopo === 'dev')),
    semMetadadoNoRegistro: semMetadado,
    variantesQueDivergem: conflitos,
    snapshotsSemPacote: semPacote,
    dependenciasSemAlvo: semAlvo,
    linksSemImporter,
    naoAlcancaveis,
    licencasDosPacotesDoMonorepo: licencasWs,
    itens,
  }
  fs.writeFileSync(path.join(out, 'analise.json'), JSON.stringify(analise, null, 1))
  const c = analise.contagem
  console.log(`importers: ${c.importers} | pacotes no lockfile: ${c.pacotesNoLockfile} | alcancaveis: ${c.pacotesAlcancaveis} (producao ${c.producao}, dev ${c.dev}) | nao alcancaveis: ${c.naoAlcancaveis}`)
  console.log(`documento do pnpm ignorado: ${c.documentoDoPnpm.pacotesIgnorados} pacotes | entradas no lock sintetico: ${c.entradasNoLockSintetico} | buscas na rede: ${c.buscasNaRede}`)
  console.log(`sem metadado no registro: ${semMetadado.length} | variantes que divergem: ${conflitos.length} | dependencias sem alvo: ${semAlvo.length} | links sem importer: ${linksSemImporter.length}`)
  console.log(`gravado em ${out} (package.json, package-lock.json, analise.json)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  principal().catch((e) => {
    console.error(`erro: ${e.stack ?? e}`)
    process.exit(2)
  })
}
