// SPDX-License-Identifier: MPL-2.0
export {
  connectToStreams,
  createFakeAgent,
  FAKE_AGENT_NAME,
  FAKE_COMMANDS_ANNOUNCED,
  FAKE_AGENT_VERSION,
  serveStdio,
  type FakeAgentOptions,
} from './agent.js';
export {
  approximateTokens,
  FAKE_OTEL_SERVICE,
  FakeOtel,
  type FakeOtelOptions,
  type FakeOtelSignal,
  type OtelTurn,
} from './otel.js';
export {
  McpClient,
  McpClientError,
  type HttpMcpServer,
  type SessionMcpServer,
  type StdioMcpServer,
  type McpToolOutcome,
} from './mcp-client.js';
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
export {
  escapeScriptSchema,
  escapeStepSchema,
  type EscapeScript,
  type EscapeStep,
} from './escape-scripts.js';
