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
//   --leak            adds `leak`, which gives back the value of an environment variable in a text
//                     part, in `structuredContent` and in an embedded resource (a server that echoes
//                     its own secret; N243, item 61), and `leak_error`, the same as a tool error
//   --panel           the tools of the panel of P10: `rows`, `items`, `stats`, `wrong_shape`,
//                     `boom` (a tool error whose text carries a "secret"), `counter` (how many
//                     times `clear`, `purge` and `ship` ran) and those three, which change things
import { createHash } from 'node:crypto';
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
    ({ name }) => {
      const value = name === undefined ? undefined : process.env[name];
      return text({
        keys: Object.keys(process.env).sort(),
        // The daemon masks a secret in what comes back (N243, item 61), so a test that wants to know
        // the value reached this process compares the digest.
        value: value ?? null,
        sha256: value === undefined ? null : createHash('sha256').update(value).digest('hex'),
        cwd: process.cwd(),
      });
    },
  );
  if (modes.has('--leak')) {
    const leaked = (name: string): string => process.env[name] ?? '';
    server.registerTool(
      'leak',
      {
        description: 'Gives an environment value back.',
        inputSchema: z.object({ name: z.string() }),
      },
      ({ name }) => ({
        content: [
          { type: 'text', text: `the value is ${leaked(name)}.` },
          { type: 'text', text: JSON.stringify({ quoted: leaked(name) }) },
          {
            type: 'resource',
            resource: {
              uri: 'file:///note.txt',
              mimeType: 'text/plain',
              text: `in a note: ${leaked(name)}`,
            },
          },
        ],
        structuredContent: {
          value: leaked(name),
          nested: { list: [`x-${leaked(name)}`, 7, null] },
        },
      }),
    );
    server.registerTool(
      'leak_error',
      { description: 'Fails with the value.', inputSchema: z.object({ name: z.string() }) },
      ({ name }) => ({
        content: [{ type: 'text', text: `failed with ${leaked(name)}` }],
        isError: true,
      }),
    );
  }
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
  if (modes.has('--panel')) {
    let changes = 0;
    const note = 'n'.repeat(40);
    server.registerTool('rows', { description: 'Five rows.' }, () =>
      text(
        Array.from({ length: 5 }, (_, index) => ({
          id: index + 1,
          name: `row-${String(index + 1)}`,
          note,
        })),
      ),
    );
    server.registerTool('items', { description: 'Three items.' }, () => text(['a', 'b', 'c']));
    server.registerTool('stats', { description: 'Two numbers.' }, () => text({ open: 2, done: 5 }));
    server.registerTool('wrong_shape', { description: 'Not an array nor an object.' }, () =>
      text('"just a string"'),
    );
    server.registerTool('boom', { description: 'Fails, saying too much.' }, () => ({
      content: [{ type: 'text', text: 'failed with token hunter2-SECRET-VALUE' }],
      isError: true,
    }));
    server.registerTool('counter', { description: 'How many changes ran.' }, () =>
      text(String(changes)),
    );
    for (const name of ['clear', 'purge', 'ship']) {
      server.registerTool(name, { description: `Changes something (${name}).` }, () => {
        changes += 1;
        return text(`${name} done`);
      });
    }
  }
  server.registerTool('pid', { description: 'The pid of this process.' }, () => text(process.pid));
  if (modes.has('--extra')) {
    server.registerTool('extra_tool', { description: 'Not in the manifest.' }, () => text('extra'));
  }
  return server;
});
