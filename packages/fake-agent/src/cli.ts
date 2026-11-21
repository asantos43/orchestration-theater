#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { createFakeAgent, FAKE_AGENT_VERSION, serveStdio } from './agent.js';
import { FakeOtel } from './otel.js';
import { parseScriptSpec, ScriptError } from './scripts.js';

/** Entry point of the `fake-agent` binary: an ACP agent on stdio. FAKE_AGENT_SCRIPT sets the default script; FAKE_AGENT_UPDATES_ON_CONFIG=1 turns on `updatesOnConfig`. With `OTEL_EXPORTER_OTLP_ENDPOINT` set (plus `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES`) it exports a span per turn, token metrics and a log per tool call as OTLP/JSON (Phase 8, P3). FAKE_AGENT_SURVIVE_EOF=1 keeps the process alive after the client closed stdin: a test-only way to make an orphan that outlives a daemon killed with `kill -9`. */
async function main(): Promise<void> {
  const spec = process.env.FAKE_AGENT_SCRIPT;
  const defaultScript = spec === undefined || spec === '' ? undefined : parseScriptSpec(spec);
  const otel = FakeOtel.fromEnv(process.env, { version: FAKE_AGENT_VERSION });
  await serveStdio(
    createFakeAgent({
      ...(otel === undefined ? {} : { otel }),
      ...(defaultScript === undefined ? {} : { defaultScript }),
      ...(process.env.FAKE_AGENT_UPDATES_ON_CONFIG === '1' ? { updatesOnConfig: true } : {}),
    }),
  );
  if (process.env.FAKE_AGENT_SURVIVE_EOF === '1') {
    // [proposta] An interval keeps the event loop alive; nothing else is served.
    setInterval(() => undefined, 60_000);
  }
}

main().catch((error: unknown) => {
  // Stdout is the protocol channel: diagnostics go to stderr only.
  const text = error instanceof ScriptError ? error.message : String(error);
  process.stderr.write(`fake-agent: ${text}\n`);
  process.exitCode = 1;
});
