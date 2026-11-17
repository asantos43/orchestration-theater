// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { ClientAdapter } from '@otheater/core';
import type { PlayExecutor } from '../config.js';
import { acceptsImages, chooseConsultant } from './consult.js';

const main: PlayExecutor = { client: 'claude-code', profile: 'p', model: 'm' };
const vision: PlayExecutor = { client: 'vision', profile: 'p', model: 'm' };
const accepts = (client: string): boolean => client === 'vision';

describe('chooseConsultant', () => {
  it('takes the Executor of the role when nothing needs an image', () => {
    expect(chooseConsultant([main, vision], false, accepts)?.executor).toBe(main);
  });

  it('skips a candidate that does not accept images when an image is attached', () => {
    const choice = chooseConsultant([main, vision], true, accepts);
    expect(choice?.executor).toBe(vision);
    expect(choice?.reason).toContain('images');
  });

  it('is undefined when nobody accepts the image, and when there are no candidates', () => {
    expect(chooseConsultant([main], true, accepts)).toBeUndefined();
    expect(chooseConsultant([], false, accepts)).toBeUndefined();
  });
});

describe('acceptsImages', () => {
  const directory = {
    adapterOf: (client: string) => {
      if (client === 'ghost') throw new Error('no such client');
      return {
        capabilities: client === 'vision' ? { inputTypes: ['image'] } : {},
      } as unknown as ClientAdapter;
    },
  };

  it('reads the input types a client declares; none declared means text only', () => {
    expect(acceptsImages(directory, 'vision')).toBe(true);
    expect(acceptsImages(directory, 'claude-code')).toBe(false);
  });

  it('is false for a client that is not there', () => {
    expect(acceptsImages(directory, 'ghost')).toBe(false);
  });
});
