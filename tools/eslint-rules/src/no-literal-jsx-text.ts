// SPDX-License-Identifier: MPL-2.0
import type { Rule } from 'eslint';

/**
 * N50: every text the person reads goes through the catalog (`t('key')`), never written in the
 * component. This rule rejects, as a child of `<Text>`, a string that has letters: JSX text
 * (`<Text>Hello</Text>`), a string literal (`{'Hello'}`) or a template literal, also as a branch of
 * `cond ? 'a' : 'b'` or `x && 'a'`. Spaces and punctuation alone (`{' '}`, `{'/'}`, `{' | '}`) are
 * not text and pass. Numbers and anything that is not a literal (`{t('a.b')}`, `{name}`) pass.
 *
 * The component names it watches are the option `components` (default `["Text"]`).
 */

/** The few fields of an ESTree/JSX node this rule reads. */
interface AstNode {
  readonly type: string;
  readonly value?: unknown;
  readonly name?: AstNode | string;
  readonly openingElement?: AstNode;
  readonly children?: readonly AstNode[];
  readonly expression?: AstNode;
  readonly consequent?: AstNode;
  readonly alternate?: AstNode;
  readonly left?: AstNode;
  readonly right?: AstNode;
  readonly quasis?: readonly { readonly value: { readonly cooked?: string | null | undefined } }[];
}

const HAS_LETTER = /\p{L}/u;

function elementName(opening: AstNode | undefined): string | undefined {
  const name = opening?.name;
  return typeof name === 'object' && name.type === 'JSXIdentifier' && typeof name.name === 'string'
    ? name.name
    : undefined;
}

/** The literal strings that would be shown if `expression` is the child. */
function literalsOf(expression: AstNode | undefined): AstNode[] {
  if (expression === undefined) return [];
  switch (expression.type) {
    case 'Literal':
      return typeof expression.value === 'string' ? [expression] : [];
    case 'TemplateLiteral':
      return [expression];
    case 'ConditionalExpression':
      return [...literalsOf(expression.consequent), ...literalsOf(expression.alternate)];
    case 'LogicalExpression':
      return [...literalsOf(expression.left), ...literalsOf(expression.right)];
    default:
      return [];
  }
}

function textOf(node: AstNode): string {
  if (node.type === 'TemplateLiteral') {
    return (node.quasis ?? []).map((quasi) => quasi.value.cooked ?? '').join('');
  }
  return typeof node.value === 'string' ? node.value : '';
}

export const noLiteralJsxText: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Screen text must come from the catalog (t(...)), not be written in the component',
    },
    schema: [
      {
        type: 'object',
        properties: { components: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      literal:
        'Text written in the component: put it in locales/<lang>/tui.json and use t("key") (N50).',
    },
  },
  create(context) {
    const options = context.options[0] as { components?: string[] } | undefined;
    const watched = new Set(options?.components ?? ['Text']);
    const report = (node: AstNode): void => {
      context.report({ node: node as unknown as Rule.Node, messageId: 'literal' });
    };
    return {
      JSXElement(raw: Rule.Node) {
        const element = raw as unknown as AstNode;
        const name = elementName(element.openingElement);
        if (name === undefined || !watched.has(name)) return;
        for (const child of element.children ?? []) {
          if (child.type === 'JSXText') {
            if (HAS_LETTER.test(textOf(child))) {
              report(child);
            }
          } else if (child.type === 'JSXExpressionContainer') {
            for (const literal of literalsOf(child.expression)) {
              if (HAS_LETTER.test(textOf(literal))) {
                report(literal);
              }
            }
          }
        }
      },
    };
  },
};
