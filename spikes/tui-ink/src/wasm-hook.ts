// Carregado pelo launcher ANTES do app (só com --trace): captura a memória linear do WASM do Yoga.
// O yoga-layout instancia o WASM por `WebAssembly.instantiate` na importação; o gancho guarda `exports.memory`.
// A lista fica em globalThis porque o launcher e o app são bundles separados.
type G = typeof globalThis & { __otWasm?: WebAssembly.Memory[] };
export const wasmMemories: WebAssembly.Memory[] = ((globalThis as G).__otWasm ??= []);

if (process.argv.includes('--trace')) {
  const orig = WebAssembly.instantiate.bind(WebAssembly) as (...a: unknown[]) => Promise<unknown>;
  (WebAssembly as unknown as { instantiate: unknown }).instantiate = async (...a: unknown[]) => {
    const r = (await orig(...a)) as { instance?: WebAssembly.Instance } | WebAssembly.Instance;
    const inst = (r as { instance?: WebAssembly.Instance }).instance ?? (r as WebAssembly.Instance);
    // o Emscripten minifica os nomes dos exports ('a', 'b'...): procura a Memory entre todos os valores
    for (const v of Object.values((inst.exports ?? {}) as Record<string, unknown>)) {
      if (v instanceof WebAssembly.Memory) wasmMemories.push(v);
    }
    return r;
  };
}
