// SPDX-License-Identifier: MPL-2.0
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'spikes/**',
      '**/dist/**',
      '**/dist-test/**',
      'docs/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.claude/**',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['*.js', '*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
