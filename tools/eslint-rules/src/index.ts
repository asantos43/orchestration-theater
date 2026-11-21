// SPDX-License-Identifier: MPL-2.0
import type { ESLint } from 'eslint';
import { noLiteralJsxText } from './no-literal-jsx-text.js';

/** The local ESLint plugin of the repository (`otheater/...`). */
export const plugin: ESLint.Plugin = {
  meta: { name: '@otheater/eslint-rules' },
  rules: { 'no-literal-jsx-text': noLiteralJsxText },
};

export default plugin;
