// Gancho para forçar o quadro logo após a tecla (--key-render flush). main.tsx liga `hooks.flush` ao
// `waitUntilRenderFlush()` da API pública do Ink (setImmediate + flushSyncWork + settle dos dois throttles).
export const hooks: { flush: (() => void) | null } = { flush: null };
export const keyFlush = (): void => { hooks.flush?.(); };
