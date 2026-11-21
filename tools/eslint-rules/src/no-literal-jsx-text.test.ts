// SPDX-License-Identifier: MPL-2.0
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin from './index.js';

function lint(code: string, options: unknown[] = []): readonly string[] {
  const linter = new Linter();
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { otheater: plugin },
        rules: { 'otheater/no-literal-jsx-text': ['error', ...options] },
      },
    ],
    { filename: 'screen.tsx' },
  );
  return messages.map(
    (message) => `${String(message.line)}:${message.messageId ?? message.message}`,
  );
}

describe('otheater/no-literal-jsx-text (N50)', () => {
  it('rejects text written inside <Text>', () => {
    expect(lint('const a = <Text>Hello</Text>;')).toEqual(['1:literal']);
  });

  it('rejects a string literal and a template literal as a child of <Text>', () => {
    expect(lint("const a = <Text>{'Hello'}</Text>;")).toEqual(['1:literal']);
    expect(lint('const a = <Text>{`Hello`}</Text>;')).toEqual(['1:literal']);
    expect(lint('const a = <Text>{`${t("x")} items`}</Text>;')).toEqual(['1:literal']);
  });

  it('rejects text in a branch of a condition and in text nested in other elements', () => {
    expect(lint("const a = <Text>{ok ? t('a') : 'Failed'}</Text>;")).toEqual(['1:literal']);
    expect(lint("const a = <Text>{ok && 'Done'}</Text>;")).toEqual(['1:literal']);
    expect(lint('const a = <Box><Text bold>Hello</Text></Box>;')).toEqual(['1:literal']);
  });

  it('rejects text with accents and in the middle of other children', () => {
    expect(lint('const a = <Text>{n} Peças</Text>;')).toEqual(['1:literal']);
  });

  it('accepts the catalog, variables, numbers and separators', () => {
    expect(lint("const a = <Text>{t('app.title')}</Text>;")).toEqual([]);
    expect(lint('const a = <Text>{name}</Text>;')).toEqual([]);
    expect(lint('const a = <Text>{String(count)}</Text>;')).toEqual([]);
    expect(lint("const a = <Text>{' '}</Text>;")).toEqual([]);
    expect(lint("const a = <Text>{a}{' | '}{b}</Text>;")).toEqual([]);
    expect(lint('const a = <Text>{12}</Text>;')).toEqual([]);
    expect(lint('const a = <Text> </Text>;')).toEqual([]);
  });

  it('does not look at elements that are not watched', () => {
    expect(lint('const a = <Box>Hello</Box>;')).toEqual([]);
    expect(lint('const a = <Label>Hello</Label>;')).toEqual([]);
  });

  it('watches the components of the option', () => {
    expect(lint('const a = <Label>Hello</Label>;', [{ components: ['Text', 'Label'] }])).toEqual([
      '1:literal',
    ]);
  });

  it('does not touch attributes (a prop is not a child)', () => {
    expect(lint("const a = <Text color='red'>{t('x')}</Text>;")).toEqual([]);
  });
});
