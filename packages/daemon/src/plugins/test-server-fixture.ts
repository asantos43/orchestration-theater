// SPDX-License-Identifier: MPL-2.0
// A plugin MCP server over stdio for the tests of the plugin processes (excluded from the build of
// the package). The tests run it with `node <this file> [modes]`: Node 24 runs the TypeScript as
// it is. Modes, after the file name:
//   --extra           also exposes `extra_tool`, which the manifest of the tests does not declare
//   --missing         leaves `echo` out, though the manifest declares it
//   --crash-on-start  exits at once, before `initialize`
//   --no-exit         `crash` throws an error of the tool instead of ending the process
//   --events          adds `publish_events`, which publishes one event the manifest declares
//                     (`build.done`) and one it does not (`not.declared`), and `publish`, which
//                     publishes the event it is told to (`notifications/otheater/event`, P8)
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const modes = new Set(process.argv.slice(2));

if (modes.has('--crash-on-start')) process.exit(3);

function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  };
}

serveStdio(() => {
  const server = new McpServer({ name: 'otheater-test-plugin', version: '1.0.0' });
  if (!modes.has('--missing')) {
    server.registerTool(
      'echo',
      { description: 'Gives the text back.', inputSchema: z.object({ text: z.string() }) },
      ({ text: value }) => text(`echo:${value}`),
    );
  }
  server.registerTool(
    'env_report',
    {
      description: 'The names of the environment variables of this process, and one value.',
      inputSchema: z.object({ name: z.string().optional() }),
    },
    ({ name }) =>
      text({
        keys: Object.keys(process.env).sort(),
        value: name === undefined ? null : (process.env[name] ?? null),
        cwd: process.cwd(),
      }),
  );
  server.registerTool(
    'slow',
    { description: 'Answers after a while.', inputSchema: z.object({ ms: z.number() }) },
    async ({ ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return text('done');
    },
  );
  server.registerTool('crash', { description: 'Ends the process.' }, () => {
    if (modes.has('--no-exit'))
      return { content: [{ type: 'text', text: 'failed' }], isError: true };
    process.exit(1);
  });
  if (modes.has('--events')) {
    const method = 'notifications/otheater/event';
    server.registerTool('publish_events', { description: 'Publishes two events.' }, async () => {
      await server.server.notification({
        method,
        params: { name: 'build.done', payload: { n: 1 } },
      });
      await server.server.notification({ method, params: { name: 'not.declared', payload: {} } });
      return text('published');
    });
    server.registerTool(
      'publish',
      {
        description: 'Publishes the event it is told to; `bytes` pads the payload.',
        inputSchema: z.object({
          name: z.string(),
          payload: z.record(z.string(), z.unknown()).optional(),
          bytes: z.number().optional(),
          raw: z.unknown().optional(),
        }),
      },
      async ({ name, payload, bytes, raw }) => {
        const body = bytes === undefined ? payload : { ...payload, pad: 'x'.repeat(bytes) };
        await server.server.notification({
          method,
          params:
            raw === undefined ? { name, ...(body === undefined ? {} : { payload: body }) } : raw,
        } as Parameters<typeof server.server.notification>[0]);
        return text('published');
      },
    );
  }
  server.registerTool('pid', { description: 'The pid of this process.' }, () => text(process.pid));
  if (modes.has('--extra')) {
    server.registerTool('extra_tool', { description: 'Not in the manifest.' }, () => text('extra'));
  }
  return server;
});
