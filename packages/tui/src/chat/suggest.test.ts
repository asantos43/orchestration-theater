// SPDX-License-Identifier: MPL-2.0
import type { ApiSlashCommand } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { completionOf, suggestionsFor, typingCommandName } from './suggest.js';

const command = (name: string): ApiSlashCommand => ({
  id: name.slice(1),
  name,
  origin: 'daemon',
  group: 'query',
  descriptionKey: '',
  description: '',
  args: '',
  confirm: false,
});

const commands = ['/status', '/stop', '/pause', '/resume'].map(command);

describe('typingCommandName', () => {
  it('is true only for a slash and a word that is not finished', () => {
    expect(typingCommandName('/')).toBe(true);
    expect(typingCommandName('/st')).toBe(true);
    expect(typingCommandName('/status now')).toBe(false);
    expect(typingCommandName('status')).toBe(false);
    expect(typingCommandName('/a\nb')).toBe(false);
  });
});

describe('suggestionsFor', () => {
  it('lists the commands that start with what was typed, in the daemon order', () => {
    expect(suggestionsFor(commands, '/', 6).map((item) => item.name)).toEqual([
      '/status',
      '/stop',
      '/pause',
      '/resume',
    ]);
    expect(suggestionsFor(commands, '/st', 6).map((item) => item.name)).toEqual([
      '/status',
      '/stop',
    ]);
  });

  it('cuts the list at the limit and gives nothing for a limit of 0', () => {
    expect(suggestionsFor(commands, '/', 2)).toHaveLength(2);
    expect(suggestionsFor(commands, '/', 0)).toEqual([]);
  });

  it('gives nothing once the text is the whole name of the only match', () => {
    expect(suggestionsFor(commands, '/pause', 6)).toEqual([]);
    expect(suggestionsFor(commands, '/pause x', 6)).toEqual([]);
    expect(suggestionsFor(commands, '/stat', 6)).toHaveLength(1);
  });

  it('completes to the name and a space', () => {
    expect(completionOf(command('/status'))).toBe('/status ');
  });
});
