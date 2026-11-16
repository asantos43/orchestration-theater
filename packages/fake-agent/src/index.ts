// SPDX-License-Identifier: MPL-2.0
export {
  connectToStreams,
  createFakeAgent,
  FAKE_AGENT_NAME,
  FAKE_AGENT_VERSION,
  serveStdio,
  type FakeAgentOptions,
} from './agent.js';
export {
  parsePrompt,
  parseScriptSpec,
  SCRIPT_NAMES,
  scriptSchema,
  ScriptError,
  type ParsedPrompt,
  type Script,
  type ScriptName,
} from './scripts.js';
