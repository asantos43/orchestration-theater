// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  ApiSlashCommandSchema,
  ListSlashCommandsQuerySchema,
  RunSlashCommandBodySchema,
  SlashCommandResultSchema,
  listCommands,
  runScenarioCommand,
} from './commands.js';
import { API_ROUTES } from './registry.js';

describe('the routes of the / commands', () => {
  it('are in the registry: the list is a GET and the run is a POST with an Idempotency-Key', () => {
    expect(API_ROUTES.listCommands).toBe(listCommands);
    expect(API_ROUTES.runScenarioCommand).toBe(runScenarioCommand);
    expect(listCommands.method).toBe('GET');
    expect(listCommands.path).toBe('/v1/commands');
    expect(runScenarioCommand.method).toBe('POST');
    expect(runScenarioCommand.path).toBe('/v1/scenarios/:scenarioId/commands');
    expect(runScenarioCommand.headers).toBeDefined();
  });

  it('takes an optional scenario and language in the query, and nothing else', () => {
    expect(ListSlashCommandsQuerySchema.parse({})).toEqual({});
    expect(ListSlashCommandsQuerySchema.parse({ scenario: 'S1', lang: 'pt-BR' })).toEqual({
      scenario: 'S1',
      lang: 'pt-BR',
    });
    expect(ListSlashCommandsQuerySchema.safeParse({ lang: 'fr' }).success).toBe(false);
    expect(ListSlashCommandsQuerySchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('takes a line that starts with a slash and a command name', () => {
    expect(RunSlashCommandBodySchema.parse({ text: '/pause' })).toEqual({ text: '/pause' });
    expect(RunSlashCommandBodySchema.parse({ text: '/cancel now', confirm: true }).confirm).toBe(
      true,
    );
    for (const bad of [
      { text: 'pause' },
      { text: '/' },
      { text: '/ pause' },
      { text: '/a', x: 1 },
    ]) {
      expect(RunSlashCommandBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('describes a command and its result', () => {
    const command = {
      id: 'claude:compact',
      name: '/claude:compact',
      origin: 'client',
      group: 'client',
      descriptionKey: '',
      description: 'Compact the conversation',
      args: '',
      confirm: false,
    };
    expect(ApiSlashCommandSchema.parse(command)).toEqual(command);
    expect(ApiSlashCommandSchema.safeParse({ ...command, origin: 'plugin' }).success).toBe(false);
    for (const status of ['done', 'confirm', 'forwarded']) {
      expect(SlashCommandResultSchema.safeParse({ status, command: 'x', text: '' }).success).toBe(
        true,
      );
    }
    expect(
      SlashCommandResultSchema.safeParse({ status: 'ok', command: 'x', text: '' }).success,
    ).toBe(false);
  });
});
