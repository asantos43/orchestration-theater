#!/usr/bin/env node
// Spike da Fase 0: verificador de licencas (prototipo da automacao da Fase 1).
// Aplica a politica da arquitetura (secao 6.0) como dados (policy.json) sobre uma arvore npm instalada.
//
// Uso: node check.mjs --dir <pasta com node_modules> [--tudo] [--com-propostas] [--json <arquivo>]
//                     [--palpite=falha|aviso] [--alertas=aviso|falha] [--so-lockfile] [--politica <arquivo>] [--quiet]
//   --so-lockfile: sem node_modules (nada baixado); usa so o package-lock.json (campo `license` do registro).
//   --alertas: arquivos de licenca GPL/LGPL/AGPL dentro de um pacote cuja licenca declarada e outra.
// Saida: 0 = ok; 1 = ha licenca proibida ou sem decisao; 2 = erro de uso ou de leitura.
//
// Motor de licencas: license-checker-rseidelsohn (BSD-3-Clause), que le o campo `license` e os arquivos
// LICENSE de cada pacote instalado. O grafo (quem trouxe quem) vem do Arborist (ISC), o mesmo do npm.
// Alem da arvore instalada, le o package-lock.json: pacotes opcionais de outras plataformas
// (ex.: @img/sharp-libvips-*) nao ficam em node_modules aqui, mas entram no instalador de outra maquina.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Arborist from '@npmcli/arborist'
import * as licenseChecker from 'license-checker-rseidelsohn'
import semver from 'semver'
import parseSpdx from 'spdx-expression-parse'

const AQUI = path.dirname(fileURLToPath(import.meta.url))

// ---------- argumentos ----------
function lerArgs(argv) {
  const a = { dir: null, tudo: false, comPropostas: false, json: null, palpite: 'falha', alertas: 'aviso', soLockfile: false, politica: path.join(AQUI, 'policy.json'), quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--dir') a.dir = argv[++i]
    else if (v === '--tudo') a.tudo = true
    else if (v === '--com-propostas') a.comPropostas = true
    else if (v === '--json') a.json = argv[++i]
    else if (v === '--politica') a.politica = argv[++i]
    else if (v === '--quiet') a.quiet = true
    else if (v === '--so-lockfile') a.soLockfile = true
    else if (v.startsWith('--alertas=')) a.alertas = v.slice('--alertas='.length)
    else if (v.startsWith('--palpite=')) a.palpite = v.slice('--palpite='.length)
    else if (v === '-h' || v === '--help') a.ajuda = true
    else throw new Error(`argumento desconhecido: ${v}`)
  }
  if (!['falha', 'aviso'].includes(a.palpite)) throw new Error('--palpite aceita "falha" ou "aviso"')
  if (!['falha', 'aviso'].includes(a.alertas)) throw new Error('--alertas aceita "falha" ou "aviso"')
  return a
}

// ---------- politica ----------
// Niveis: 0 permitida, 1 decidida (excecao), 2 sem decisao, 3 proibida.
const OK = 0
const DECIDIDA = 1
const SEM_DECISAO = 2
const PROIBIDA = 3
const NOME_NIVEL = ['permitida', 'decidida', 'sem-decisao', 'proibida']

function globParaRegex(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
}

function carregarPolitica(arquivo, comPropostas) {
  const p = JSON.parse(fs.readFileSync(arquivo, 'utf8'))
  const pol = {
    permitidas: new Set((p.permitidas ?? []).map((s) => s.toLowerCase())),
    proibidas: (p.proibidas ?? []).map(globParaRegex),
    porLicenca: new Map(),
    excecoes: [...(p.excecoes ?? [])],
  }
  const listas = [p.decisoesPorLicenca ?? []]
  if (comPropostas) {
    const prop = JSON.parse(fs.readFileSync(path.join(path.dirname(arquivo), 'proposals.json'), 'utf8'))
    listas.push(prop.decisoesPorLicenca ?? [])
    pol.excecoes.push(...(prop.excecoes ?? []))
  }
  for (const l of listas) for (const d of l) pol.porLicenca.set(d.licenca.toLowerCase(), d)
  return pol
}

// ---------- classificacao de uma licenca ----------
// Um id SPDX isolado.
function classificarId(id, pol) {
  const baixo = id.toLowerCase()
  if (pol.proibidas.some((r) => r.test(id))) return { nivel: PROIBIDA, motivo: `${id} esta na lista de proibidas` }
  if (pol.permitidas.has(baixo)) return { nivel: OK }
  const d = pol.porLicenca.get(baixo)
  if (d) return { nivel: DECIDIDA, motivo: `${id}: decisao por licenca (${d.data ?? 'sem data'})` }
  return { nivel: SEM_DECISAO, motivo: `${id} fora da lista, sem decisao` }
}

// Arvore SPDX: OR = o consumidor escolhe a melhor alternativa; AND = vale a pior.
function classificarNo(no, pol) {
  if (no.license) {
    const id = no.plus ? `${no.license}+` : no.license
    const idBase = no.license
    // "GPL-2.0+" e GPL: a regra de proibida pega pelo prefixo.
    const r = classificarId(idBase, pol)
    return { ...r, ids: [id] }
  }
  const e = classificarNo(no.left, pol)
  const d = classificarNo(no.right, pol)
  const ids = [...e.ids, ...d.ids]
  if (no.conjunction === 'or') {
    const m = e.nivel <= d.nivel ? e : d
    return { ...m, ids }
  }
  const m = e.nivel >= d.nivel ? e : d
  return { ...m, ids }
}

// `texto` e o que o verificador leu: string, ou lista (varias licencas declaradas = escolha, como OR).
function classificarLicenca(entrada, pol) {
  const lista = Array.isArray(entrada) ? entrada : [entrada]
  let melhor = null
  for (const bruto of lista) {
    let s = String(bruto ?? 'UNKNOWN').trim()
    let palpite = false
    if (s.endsWith('*')) {
      palpite = true
      s = s.slice(0, -1)
    }
    let r
    if (!s || /^(unknown|unlicensed)$/i.test(s) || /^custom\b/i.test(s) || /^see license/i.test(s)) {
      r = { nivel: SEM_DECISAO, motivo: `licenca "${s || 'vazia'}" nao identificada`, ids: [s || 'UNKNOWN'] }
    } else {
      try {
        r = classificarNo(parseSpdx(s), pol)
      } catch {
        r = { nivel: SEM_DECISAO, motivo: `expressao "${s}" nao e SPDX valido`, ids: [s] }
      }
    }
    r.palpite = palpite
    if (!melhor || r.nivel < melhor.nivel) melhor = r
  }
  return melhor
}

function acharExcecao(pol, nome, versao, licencaTexto, escopo) {
  return pol.excecoes.find((x) => {
    if (x.pacote !== nome) return false
    if (x.versoes && !semver.satisfies(versao, x.versoes)) return false
    if (x.licenca && x.licenca !== licencaTexto) return false
    const e = x.escopo ?? 'qualquer'
    return e === 'qualquer' || e === escopo
  })
}

// ---------- grafo (Arborist) ----------
async function lerGrafo(dir) {
  const arb = new Arborist({ path: dir })
  const raiz = await arb.loadActual()
  return raiz
}

// Busca em largura a partir da raiz. Devolve, por no, o caminho mais curto. Com `soProd`, ignora arestas de dev da raiz.
function alcancar(raiz, soProd) {
  const pai = new Map([[raiz, null]])
  const fila = [raiz]
  while (fila.length) {
    const n = fila.shift()
    for (const [, e] of n.edgesOut) {
      if (!e.to) continue
      if (soProd && n === raiz && e.dev) continue
      if (e.dev && n !== raiz) continue // dependencias de desenvolvimento de pacotes nao sao instaladas
      if (pai.has(e.to)) continue
      pai.set(e.to, n)
      fila.push(e.to)
    }
  }
  return pai
}

function caminhoAte(no, pai, raiz) {
  const partes = []
  for (let n = no; n; n = pai.get(n)) partes.push(n === raiz ? `(raiz) ${n.package?.name ?? path.basename(n.path)}` : `${n.packageName ?? n.name}@${n.version}`)
  return partes.reverse().join(' > ')
}

// ---------- verificador ----------
function rodarVerificador(dir) {
  return new Promise((resolve, reject) => {
    licenseChecker.init({ start: dir, json: true, excludePrivatePackages: false }, (err, dados) => (err ? reject(err) : resolve(dados)))
  })
}

function chaveNV(chave) {
  const i = chave.lastIndexOf('@')
  return { nome: chave.slice(0, i), versao: chave.slice(i + 1) }
}

// Procura, dentro da pasta de um pacote, arquivos de licenca copyleft (GPL, LGPL, AGPL) que o campo `license`
// nao menciona. Ex.: @openai/codex-linux-x64 declara Apache-2.0 e leva `licenses/LGPL-2.1.txt` com bibliotecas LGPL.
const RE_COPYLEFT = /(?:^|[-_. ])(?:a|l)?gpl(?:[-_. ]?v?\d|\.(?:txt|md)$|$)|^copying\.lesser/i
function arquivosCopyleft(pasta, limite = 3000) {
  const achados = []
  let visitados = 0
  const pilha = [[pasta, 0]]
  while (pilha.length && visitados < limite) {
    const [d, prof] = pilha.pop()
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      visitados++
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && prof < 6) pilha.push([path.join(d, e.name), prof + 1])
      } else if (RE_COPYLEFT.test(e.name)) achados.push(path.relative(pasta, path.join(d, e.name)))
    }
  }
  return achados
}

export async function verificar({ dir, tudo = false, comPropostas = false, palpite = 'falha', alertas = 'aviso', soLockfile = false, politica }) {
  const pol = carregarPolitica(politica, comPropostas)
  const modoLock = soLockfile
  const arb = new Arborist({ path: dir })
  const raiz = modoLock ? await arb.loadVirtual() : await arb.loadActual()
  const dados = modoLock ? {} : await rodarVerificador(dir)
  const paiProd = alcancar(raiz, true)
  const paiTodos = alcancar(raiz, false)

  // nome@versao -> no do Arborist (primeiro encontrado; a licenca e a mesma em toda copia da mesma versao)
  const nos = new Map()
  for (const n of raiz.inventory.values()) {
    if (n === raiz || n.isLink) continue
    const k = `${n.packageName ?? n.name}@${n.version}`
    if (!nos.has(k)) nos.set(k, n)
  }

  const itens = []
  const vistos = new Set()
  let privados = 0
  let alertasN = 0

  const fonte = modoLock ? Object.fromEntries([...nos.entries()].map(([k, n]) => [k, { licenses: n.package.license ?? (n.package.licenses ? n.package.licenses.map((l) => l.type ?? l) : 'UNKNOWN'), private: n.package.private }])) : dados

  for (const [chave, info] of Object.entries(fonte)) {
    const { nome, versao } = chaveNV(chave)
    const no = nos.get(chave)
    if (!no) continue // a propria raiz
    if (info.private || no.package?.private) {
      privados++
      continue
    }
    const emProd = paiProd.has(no)
    const alcancavel = paiTodos.has(no)
    const escopo = emProd ? 'producao' : 'dev'
    if (!tudo && !emProd) continue
    vistos.add(`${nome}@${versao}`)
    const item = montarItem({ nome, versao, licenca: info.licenses, escopo, origem: modoLock ? 'lockfile' : 'instalado', caminho: alcancavel ? caminhoAte(no, tudo ? paiTodos : paiProd, raiz) : '(nao alcancavel a partir da raiz)', arquivo: info.licenseFile ? path.relative(dir, info.licenseFile) : null, noticia: info.noticeFile ? true : false, repositorio: info.repository ?? null }, pol, palpite)
    if (!modoLock && no.path && fs.existsSync(no.path)) {
      const cl = arquivosCopyleft(no.path)
      if (cl.length && !/gpl/i.test(item.licenca)) {
        item.alertas = cl.slice(0, 8)
        alertasN++
      }
    }
    itens.push(item)
  }

  // pacotes do lockfile que nao estao instalados aqui (opcionais de outras plataformas)
  let lockfileExtras = 0
  const lockPath = path.join(dir, 'package-lock.json')
  if (!modoLock && fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    for (const [chave, pk] of Object.entries(lock.packages ?? {})) {
      if (!chave || pk.link) continue
      const nome = pk.name ?? chave.slice(chave.lastIndexOf('node_modules/') + 'node_modules/'.length)
      const versao = pk.version
      if (!versao || vistos.has(`${nome}@${versao}`)) continue
      if (nos.has(`${nome}@${versao}`)) continue
      if (pk.private) continue
      const escopo = pk.dev ? 'dev' : 'producao'
      if (!tudo && escopo === 'dev') continue
      lockfileExtras++
      vistos.add(`${nome}@${versao}`)
      itens.push(montarItem({ nome, versao, licenca: pk.license ?? 'UNKNOWN', escopo, origem: 'lockfile (nao instalado nesta maquina)', caminho: `package-lock.json: ${chave}${pk.os ? ` [os=${[].concat(pk.os).join(',')}]` : ''}${pk.cpu ? ` [cpu=${[].concat(pk.cpu).join(',')}]` : ''}`, arquivo: null, noticia: false, repositorio: null }, pol, palpite))
    }
  }

  const resumo = { total: itens.length, privadosIgnorados: privados, lockfileExtras, alertas: alertasN, porNivel: { permitida: 0, decidida: 0, 'sem-decisao': 0, proibida: 0 }, porLicenca: {} }
  for (const it of itens) {
    resumo.porNivel[it.situacao]++
    resumo.porLicenca[it.licenca] = (resumo.porLicenca[it.licenca] ?? 0) + 1
  }
  const falhas = itens.filter((i) => i.situacao === 'proibida' || i.situacao === 'sem-decisao' || (alertas === 'falha' && i.alertas))
  const comAlertas = itens.filter((i) => i.alertas)
  return { dir: path.basename(dir), modo: modoLock ? 'so-lockfile' : 'instalado', escopo: tudo ? 'tudo (producao + dev)' : 'producao', comPropostas, resumo, falhas, alertas: comAlertas, itens }
}

function montarItem(base, pol, palpite) {
  const c = classificarLicenca(base.licenca, pol)
  let nivel = c.nivel
  let motivo = c.motivo ?? null
  let decisao = null
  if (nivel === OK && c.palpite && palpite === 'falha') {
    nivel = SEM_DECISAO
    motivo = `licenca inferida pelo verificador ("${base.licenca}"), sem campo license no pacote`
  }
  const texto = Array.isArray(base.licenca) ? base.licenca.join(' | ') : String(base.licenca)
  if (nivel >= SEM_DECISAO) {
    const x = acharExcecao(pol, base.nome, base.versao, texto, base.escopo)
    // Licenca proibida so cai por excecao que diga `permiteProibida: true` (decisao explicita do dono).
    if (x && (nivel < PROIBIDA || x.permiteProibida === true)) {
      nivel = DECIDIDA
      decisao = x
      motivo = `excecao: ${x.motivo ?? ''} (${x.data ?? 'sem data'})`
    }
  }
  return { ...base, licenca: texto, situacao: NOME_NIVEL[nivel], motivo, decisao: decisao ? { decididoPor: decisao.decididoPor, data: decisao.data, fonte: decisao.fonte } : null }
}

// ---------- saida ----------
function imprimir(r, quiet) {
  const { resumo } = r
  console.log(`Arvore: ${r.dir} | escopo: ${r.escopo}${r.comPropostas ? ' | COM PROPOSTAS (nao e decisao)' : ''}`)
  console.log(`Modo: ${r.modo}. Pacotes: ${resumo.total} (privados ignorados: ${resumo.privadosIgnorados}; so no lockfile: ${resumo.lockfileExtras}; com alerta de arquivo copyleft: ${resumo.alertas})`)
  console.log(`  permitidas: ${resumo.porNivel.permitida} | decididas: ${resumo.porNivel.decidida} | sem decisao: ${resumo.porNivel['sem-decisao']} | proibidas: ${resumo.porNivel.proibida}`)
  if (!quiet) {
    const ord = Object.entries(resumo.porLicenca).sort((a, b) => b[1] - a[1])
    console.log('  licencas: ' + ord.map(([l, n]) => `${l}=${n}`).join(', '))
  }
  for (const f of r.falhas) {
    console.log(`\n[${f.situacao.toUpperCase()}] ${f.nome}@${f.versao}  licenca: ${f.licenca}  (${f.escopo}, ${f.origem})`)
    console.log(`  motivo:  ${f.motivo}`)
    console.log(`  trazido: ${f.caminho}`)
    if (f.arquivo) console.log(`  arquivo: ${f.arquivo}`)
  }
  for (const f of r.alertas.filter((x) => !r.falhas.includes(x))) {
    console.log(`\n[ALERTA] ${f.nome}@${f.versao}  licenca declarada: ${f.licenca}  (${f.escopo})`)
    console.log(`  arquivo(s) de licenca copyleft dentro do pacote: ${f.alertas.join(', ')}`)
    console.log(`  trazido: ${f.caminho}`)
  }
  console.log(r.falhas.length ? `\nREPROVADO: ${r.falhas.length} pacote(s) proibido(s) ou sem decisao.` : '\nAPROVADO: nenhuma licenca proibida ou sem decisao.')
}

async function principal() {
  let a
  try {
    a = lerArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  if (a.ajuda || !a.dir) {
    console.log('Uso: node check.mjs --dir <pasta com node_modules> [--tudo] [--com-propostas] [--palpite=falha|aviso] [--alertas=aviso|falha] [--so-lockfile] [--json <arquivo>] [--politica <arquivo>] [--quiet]')
    process.exit(a.ajuda ? 0 : 2)
  }
  const dir = path.resolve(a.dir)
  if (!a.soLockfile && !fs.existsSync(path.join(dir, 'node_modules'))) {
    console.error(`sem node_modules em ${dir} (use --so-lockfile para ler so o package-lock.json)`)
    process.exit(2)
  }
  try {
    const r = await verificar({ dir, tudo: a.tudo, comPropostas: a.comPropostas, palpite: a.palpite, alertas: a.alertas, soLockfile: a.soLockfile, politica: a.politica })
    imprimir(r, a.quiet)
    if (a.json) fs.writeFileSync(a.json, JSON.stringify(r, null, 2))
    process.exit(r.falhas.length ? 1 : 0)
  } catch (e) {
    console.error(`erro: ${e.stack ?? e}`)
    process.exit(2)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) principal()
