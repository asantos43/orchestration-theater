// Localização de cliques. Cada caixa que importa mede a si mesma com useBoxMetrics (left/top RELATIVOS AO PAI)
// e soma a origem do pai (contexto); o resultado é um retângulo absoluto na tela, guardado num registro.
// Para a origem não quebrar, toda caixa da cadeia entre a raiz e um alvo é um PBox.
import React, { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Box, Text, useBoxMetrics, type BoxProps, type DOMElement } from 'ink';
import { style } from './theme.js';
import type { Parts } from './text.js';

export interface Rect { x: number; y: number; w: number; h: number }

export class Registry {
  private m = new Map<string, Rect>();
  set(id: string, r: Rect) { this.m.set(id, r); }
  delete(id: string) { this.m.delete(id); }
  get(id: string) { return this.m.get(id); }
  size() { return this.m.size; }
  /** alvos que contêm o ponto; o menor primeiro */
  at(x: number, y: number): { id: string; rect: Rect }[] {
    const out: { id: string; rect: Rect }[] = [];
    for (const [id, rect] of this.m) if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) out.push({ id, rect });
    return out.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
  }
  dump() { return [...this.m].map(([id, r]) => `${id} ${r.x},${r.y} ${r.w}x${r.h}`); }
}

const RegCtx = createContext<Registry>(new Registry());
const OriginCtx = createContext<{ x: number; y: number }>({ x: 0, y: 0 });
export const RegistryProvider = RegCtx.Provider;

export type PBoxProps = BoxProps & { regId?: string; children?: ReactNode };

/** Box que mede a si mesma, acumula a origem e (com regId) se registra para o hit-test. */
export function PBox({ regId, children, ...rest }: PBoxProps) {
  const ref = useRef<DOMElement>(null);
  const m = useBoxMetrics(ref);
  const o = useContext(OriginCtx);
  const reg = useContext(RegCtx);
  const origin = useMemo(() => ({ x: o.x + m.left, y: o.y + m.top }), [o.x, o.y, m.left, m.top]);
  useEffect(() => {
    if (!regId || !m.hasMeasured) return;
    reg.set(regId, { x: origin.x, y: origin.y, w: m.width, h: m.height });
    return () => reg.delete(regId);
  }, [reg, regId, origin.x, origin.y, m.width, m.height, m.hasMeasured]);
  return (
    <OriginCtx.Provider value={origin}>
      <Box ref={ref} {...rest}>{children}</Box>
    </OriginCtx.Provider>
  );
}

function Run({ parts }: { parts: Parts }) {
  return (
    <Text wrap="truncate">
      {parts.map(([s, k], i) => <Text key={i} {...style(k ?? '')}>{s}</Text>)}
    </Text>
  );
}

/**
 * Uma linha da tela: segmentos coloridos; trechos consecutivos com o mesmo alvo de clique viram um PBox registrado.
 * Sem alvos, é um único Text (o caso comum e o mais barato).
 */
export function Line({ parts, width }: { parts: Parts; width?: number }) {
  const hasHit = parts.some(p => p[2]);
  if (!hasHit) {
    return <Box flexShrink={0} height={1} {...(width != null ? { width } : {})}><Run parts={parts} /></Box>;
  }
  const runs: { hit?: string; parts: Parts; len: number }[] = [];
  for (const p of parts) {
    const last = runs[runs.length - 1];
    if (last && last.hit === p[2]) { last.parts.push(p); last.len += p[0].length; }
    else runs.push({ hit: p[2], parts: [p], len: p[0].length });
  }
  return (
    <PBox flexShrink={0} height={1} flexDirection="row" {...(width != null ? { width } : {})}>
      {runs.map((r, i) => r.hit
        ? <PBox key={i} flexShrink={0} width={r.len} height={1} regId={r.hit + '#' + i}><Run parts={r.parts} /></PBox>
        : <Box key={i} flexShrink={0} width={r.len} height={1}><Run parts={r.parts} /></Box>)}
    </PBox>
  );
}

export const Blank = ({ n = 1 }: { n?: number }) => <Box flexShrink={0} height={n} />;
