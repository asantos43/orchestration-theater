// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, PermissionDenied } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_MODES,
  DEFAULT_INITIAL_MODE,
  VETOED_MODES,
  assertModeAllowed,
  modePolicyOf,
} from './modes.js';

describe('modePolicyOf', () => {
  it('accepts the defaults', () => {
    expect(modePolicyOf(DEFAULT_INITIAL_MODE, DEFAULT_ALLOWED_MODES)).toEqual({
      initial: 'workspace-write',
      allowed: ['read-only', 'workspace-write'],
    });
  });

  it.each(VETOED_MODES)('never lets the vetoed mode %s in, as initial or allowed', (mode) => {
    expect(() => modePolicyOf(mode, ['workspace-write', mode])).toThrow(InvalidInput);
    expect(() => modePolicyOf('workspace-write', ['workspace-write', mode])).toThrow(InvalidInput);
  });

  it('wants the initial mode among the allowed ones and a known sandbox for it', () => {
    expect(() => modePolicyOf('read-only', ['workspace-write'])).toThrow(InvalidInput);
    expect(() => modePolicyOf('permission-profile:x', ['permission-profile:x'])).toThrow(
      InvalidInput,
    );
    expect(() => modePolicyOf('Bad Mode', ['Bad Mode'])).toThrow(InvalidInput);
  });
});

describe('assertModeAllowed', () => {
  const policy = modePolicyOf(DEFAULT_INITIAL_MODE, DEFAULT_ALLOWED_MODES);

  it('lets the allowed modes through', () => {
    expect(() => {
      assertModeAllowed(policy, 'read-only');
    }).not.toThrow();
    expect(() => {
      assertModeAllowed(policy, 'workspace-write');
    }).not.toThrow();
  });

  it.each([...VETOED_MODES, 'permission-profile:custom', 'anything'])('refuses %s', (mode) => {
    expect(() => {
      assertModeAllowed(policy, mode);
    }).toThrow(PermissionDenied);
  });
});
