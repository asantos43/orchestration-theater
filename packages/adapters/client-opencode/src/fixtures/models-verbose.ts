// SPDX-License-Identifier: MPL-2.0

/**
 * HAND-MADE. This is not a capture of `opencode models --verbose`: the command was never run in
 * this step (N57). It follows the shape the command prints according to its source [S] (a line
 * `providerID/modelID`, then the model as indented JSON) and the fields Phase 0, item 9, measured
 * in the catalog of 1.19.5 [V]. The model ids and numbers are invented.
 */
export const VERBOSE_MODELS: Readonly<Record<string, unknown>> = {
  'alpha/reasoner-large': {
    id: 'reasoner-large',
    providerID: 'alpha',
    name: 'Reasoner Large',
    family: 'reasoner',
    api: { id: 'reasoner-large', url: 'https://api.alpha.example/v1', npm: '@ai-sdk/openai' },
    status: 'active',
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true },
      output: { text: true },
    },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context: 200000, output: 32000 },
    variants: { low: {}, medium: {}, high: {} },
  },
  'alpha/reasoner-small': {
    id: 'reasoner-small',
    providerID: 'alpha',
    name: 'Reasoner Small',
    family: 'reasoner',
    api: { id: 'reasoner-small', url: 'https://api.alpha.example/v1', npm: '@ai-sdk/openai' },
    capabilities: { reasoning: false, toolcall: true },
    cost: { input: 0.25, output: 1.25 },
    limit: { context: 32000, output: 8000 },
    variants: {},
  },
  // The prefix of the id (`gateway`) is the way in, not the family: the family comes from the registry.
  'gateway/alpha-reasoner-large': {
    id: 'alpha-reasoner-large',
    providerID: 'gateway',
    name: 'Reasoner Large (gateway)',
    family: 'reasoner',
    api: { id: 'alpha-reasoner-large', url: 'https://gateway.example/v1' },
    capabilities: { toolcall: true },
    cost: { input: 3.3, output: 16.5 },
    limit: { context: 200000, output: 32000 },
    variants: { low: {}, high: {} },
  },
  // `family` is empty in a part of the real registry [V]: it stays empty here.
  'gateway/mystery-model': {
    id: 'mystery-model',
    providerID: 'gateway',
    name: 'Mystery',
    family: '',
    api: { id: 'mystery-model', url: 'https://gateway.example/v1' },
    capabilities: { toolcall: true },
    limit: { context: 128000, output: 4096 },
    variants: { max: {} },
  },
  'local/llama-8b': {
    id: 'llama-8b',
    providerID: 'local',
    name: 'Llama 8B (local)',
    family: 'llama',
    api: { id: 'llama-8b', url: 'http://localhost:11434/v1' },
    capabilities: { toolcall: true },
    cost: { input: 0, output: 0 },
    limit: { context: 16000, output: 4096 },
    variants: {},
  },
  'local/completion-only': {
    id: 'completion-only',
    providerID: 'local',
    name: 'Completion only',
    family: 'llama',
    api: { id: 'completion-only', url: 'http://127.0.0.1:8080/v1' },
    capabilities: { toolcall: false },
    limit: { context: 8000, output: 2048 },
    variants: {},
  },
  // No `capabilities` at all: whether it calls tools is not said.
  'beta/unspecified': {
    id: 'unspecified',
    providerID: 'beta',
    name: 'Unspecified',
    family: 'beta',
    api: { id: 'unspecified', url: 'https://api.beta.example' },
    variants: { fast: {}, slow: {} },
  },
};

/** The text `opencode models --verbose` would print for {@link VERBOSE_MODELS}. */
export function renderVerbose(models: Readonly<Record<string, unknown>> = VERBOSE_MODELS): string {
  return Object.entries(models)
    .map(([id, model]) => `${id}\n${JSON.stringify(model, null, 2)}`)
    .join('\n');
}

export const MODELS_VERBOSE_OUTPUT = renderVerbose();
