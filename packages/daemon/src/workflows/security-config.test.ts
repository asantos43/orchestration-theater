// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { DEFAULT_WORKFLOW_SECURITY, workflowSecuritySettings } from './security-config.js';

describe('workflows.security and workflows.codehost', () => {
  it('the defaults of the configuration are the defaults of the engine', () => {
    expect(workflowSecuritySettings(parseConfig('').workflows)).toEqual(DEFAULT_WORKFLOW_SECURITY);
  });

  it('by default push, comment and label need an approval', () => {
    expect([...DEFAULT_WORKFLOW_SECURITY.requireApproval].sort()).toEqual([
      'comment',
      'label',
      'push',
    ]);
  });

  it('reads a list, the cut and the marker', () => {
    const config = parseConfig(
      [
        'workflows:',
        '  security:',
        '    require_approval: [push, comment]',
        '    untrusted_text: mark',
        '    untrusted_max_chars: 5000',
        '  codehost:',
        '    comment_marker: off',
        '',
      ].join('\n'),
    );
    expect(workflowSecuritySettings(config.workflows)).toEqual({
      requireApproval: ['push', 'comment'],
      untrustedText: 'mark',
      untrustedMaxChars: 5_000,
      commentMarker: 'off',
    });
  });

  it('none asks for no approval', () => {
    const config = parseConfig('workflows:\n  security:\n    require_approval: none\n');
    expect(workflowSecuritySettings(config.workflows).requireApproval).toEqual([]);
  });

  it('rejects an unknown write, an unknown mode and a cut out of range', () => {
    expect(() => parseConfig('workflows:\n  security:\n    require_approval: [merge]\n')).toThrow(
      /require_approval/,
    );
    expect(() => parseConfig('workflows:\n  security:\n    untrusted_text: trust\n')).toThrow(
      /untrusted_text/,
    );
    expect(() => parseConfig('workflows:\n  security:\n    untrusted_max_chars: 10\n')).toThrow(
      /untrusted_max_chars/,
    );
    expect(() => parseConfig('workflows:\n  codehost:\n    comment_marker: maybe\n')).toThrow(
      /comment_marker/,
    );
    expect(() => parseConfig('workflows:\n  security:\n    nothing: 1\n')).toThrow(/nothing/);
  });
});
