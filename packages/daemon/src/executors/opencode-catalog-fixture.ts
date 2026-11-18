// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the cadastro of Executors only (excluded from the build of the package).
import { join } from 'node:path';
import { OpenCodeModelCatalog } from '../compose.js';
import {
  assertLaunchOptions,
  PROCESS_LAUNCHER_PORT_VERSION,
  type AdapterImplements,
  type KillReport,
  type LauncherCapabilities,
  type LaunchedProcess,
  type LaunchOptions,
  type ModelCatalog,
  type ProcessLauncher,
} from '@otheater/core';

/**
 * HAND-MADE, like the fixture of the OpenCode adapter: `opencode models --verbose` was never run
 * for this step (N57). The shape is the one the adapter's parser reads (a line `providerID/modelID`,
 * then the model as indented JSON); the ids and numbers are invented.
 */
const MODELS: Readonly<Record<string, unknown>> = {
  'minimax/MiniMax-M2': {
    id: 'MiniMax-M2',
    providerID: 'minimax',
    name: 'MiniMax M2',
    family: 'minimax',
    api: { id: 'MiniMax-M2', url: 'https://api.minimax.example/v1' },
    capabilities: { reasoning: true, toolcall: true },
    cost: { input: 0.3, output: 1.2 },
    limit: { context: 200000, output: 32000 },
    variants: { low: {}, medium: {}, high: {} },
  },
  // `family` is empty in a part of the real registry [V]: the cadastro must ask for it.
  'gateway/mystery-model': {
    id: 'mystery-model',
    providerID: 'gateway',
    name: 'Mystery',
    family: '',
    api: { id: 'mystery-model', url: 'https://gateway.example/v1' },
    capabilities: { reasoning: false, toolcall: true },
    limit: { context: 128000, output: 4096 },
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
  'local/qwen-coder': {
    id: 'qwen-coder',
    providerID: 'local',
    name: 'Qwen Coder (local)',
    family: 'qwen',
    api: { id: 'qwen-coder', url: 'http://127.0.0.1:8080/v1' },
    capabilities: { reasoning: true, toolcall: true },
    cost: { input: 0, output: 0 },
    limit: { context: 64000, output: 8192 },
    variants: {},
  },
  // A small window: below the minimum of the roles that ask for context.
  'minimax/small-context': {
    id: 'small-context',
    providerID: 'minimax',
    name: 'Small context',
    family: 'minimax',
    api: { id: 'small-context', url: 'https://api.minimax.example/v1' },
    capabilities: { reasoning: false, toolcall: true },
    limit: { context: 4000, output: 1000 },
    variants: {},
  },
};

export const OPENCODE_VERBOSE_OUTPUT: string = Object.entries(MODELS)
  .map(([id, model]) => `${id}\n${JSON.stringify(model, null, 2)}`)
  .join('\n');

/** A launcher whose every process prints `stdout` and ends well (what `opencode models` would do). */
class PrintingLauncher implements ProcessLauncher {
  readonly id = 'printing';
  readonly implements: AdapterImplements = {
    port: 'ProcessLauncher',
    range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
  };
  /** The command lines launched, to assert that the real `opencode` is never the one asked. */
  readonly launched: LaunchOptions[] = [];

  constructor(private readonly stdout: string) {}

  capabilities(): LauncherCapabilities {
    return { treeKill: 'process-group', memoryLimit: false, suspendedStart: false };
  }

  launch(options: LaunchOptions): Promise<LaunchedProcess> {
    try {
      assertLaunchOptions(options);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.launched.push(options);
    const bytes = new TextEncoder().encode(this.stdout);
    const empty = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    const process: LaunchedProcess = {
      pid: 5_000_000 + this.launched.length,
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      stderr: empty(),
      exited: Promise.resolve({ code: 0, signal: null }),
      killTree: (): Promise<KillReport> =>
        Promise.resolve({ found: 1, forced: false, remaining: [] }),
    };
    return Promise.resolve(process);
  }
}

/** The OpenCode catalog on the fixture: the real parser and `suggest`, a command that never runs. */
export function fixtureOpenCodeCatalog(options: {
  /** Directory under which the catalog makes each profile's files (a temp dir in the tests). */
  readonly profileRoot: string;
  readonly stdout?: string;
  readonly minContextWindow?: number;
}): {
  readonly catalog: ModelCatalog;
  readonly launcher: { readonly launched: readonly LaunchOptions[] };
} {
  const launcher = new PrintingLauncher(options.stdout ?? OPENCODE_VERBOSE_OUTPUT);
  const catalog = new OpenCodeModelCatalog({
    launcher,
    baseEnv: { PATH: '/usr/bin' },
    profileDir: (profile) => join(options.profileRoot, profile.client, profile.profile),
    cacheMs: 0,
    ...(options.minContextWindow === undefined
      ? {}
      : { minContextWindow: options.minContextWindow }),
  });
  return { catalog, launcher };
}
