// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { OTHEATER_CORE_VERSION } from './index.js';

describe('@otheater/core', () => {
  it('exporta a versão', () => {
    expect(OTHEATER_CORE_VERSION).toBe('0.0.0');
  });
});
