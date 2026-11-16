// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { OllamaServer } from './index.js';

// Test against a REAL Ollama, off by default (N57, N71). `OT_TEST_REAL_OLLAMA=1` turns it on and
// `OT_TEST_OLLAMA_URL` is the base URL of an Ollama the owner started (for example the dev one of
// `spikes/local-model/ollama.sh`). Only `GET`s go out, and no text is generated: no model is
// loaded or pulled, and nothing is read from the data folder of Ollama.
// [proposta] The test never starts, stops or configures the server.

const enabled = process.env.OT_TEST_REAL_OLLAMA === '1';
const url = process.env.OT_TEST_OLLAMA_URL;

describe.skipIf(!enabled)('OllamaServer against a real Ollama (OT_TEST_REAL_OLLAMA=1)', () => {
  const server = new OllamaServer({ timeoutMs: 10_000 });

  it('needs OT_TEST_OLLAMA_URL', () => {
    expect(url, 'set OT_TEST_OLLAMA_URL to the base URL of an Ollama').toBeTruthy();
  });

  it('is ok on /api/version, and on the banner of /', async () => {
    expect(await server.health(url ?? '')).toEqual({ status: 'ok' });
    expect(await new OllamaServer({ healthProbe: 'root' }).health(url ?? '')).toEqual({
      status: 'ok',
    });
  });

  it('lists the installed models by name', async () => {
    const models = await server.models(url ?? '');
    for (const model of models) expect(model.id.length).toBeGreaterThan(0);
  });

  it('answers slots without a count (OLLAMA_NUM_PARALLEL is not in the API) [N]', async () => {
    const slots = await server.slots(url ?? '');
    expect(slots.count).toBeUndefined();
    if (slots.contextPerSlot !== undefined) expect(slots.contextPerSlot).toBeGreaterThan(0);
  });
});
