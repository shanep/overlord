// ESLint flat config. Everything runs at its strictest preset, and any rule
// that is turned off has a comment saying why.
import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import n from 'eslint-plugin-n';
import promise from 'eslint-plugin-promise';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import regexp from 'eslint-plugin-regexp';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.cache/**',
      'dist/**',
      'out/**',
      'coverage/**',
      'reports/**',
      '.stryker-tmp*/**',
      '.vscode-test/**',
      'webview/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  unicorn.configs['flat/recommended'],
  sonarjs.configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    settings: {
      // vscode is provided by the editor at runtime (types come from @types/vscode).
      'import-x/core-modules': ['vscode'],
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          project: ['tsconfig.json', 'webview/tsconfig.json'],
          noWarnOnMultipleProjects: true,
        }),
      ],
    },
  },
  promise.configs['flat/recommended'],
  regexp.configs['flat/recommended'],
  security.configs.recommended,
  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      // A leading underscore marks an argument that is unused on purpose.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-use-before-define': 'error',
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/method-signature-style': 'error',
      '@typescript-eslint/no-unnecessary-parameter-property-assignment': 'error',
      '@typescript-eslint/no-useless-empty-export': 'error',
      '@typescript-eslint/prefer-enum-initializers': 'error',
      '@typescript-eslint/no-loop-func': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-console': 'error',
      'no-param-reassign': 'error',
      'no-implicit-coercion': 'error',
      'no-nested-ternary': 'error',
      'prefer-template': 'error',
      'object-shorthand': 'error',
      complexity: ['error', 12],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-default-export': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: [
            '**/*.test.ts',
            '**/*.test.tsx',
            '**/test-helpers/**',
            'test/**',
            'scripts/**',
            'webview/test/**',
            'webview/vite.config.ts',
            '*.config.ts',
            '*.config.mjs',
            '*.config.mts',
            'eslint.config.mjs',
            '.vscode-test.mjs',
            '.dependency-cruiser.cjs',
          ],
        },
      ],
      'import-x/order': ['error', { 'newlines-between': 'always', alphabetize: { order: 'asc' } }],
      // TypeScript already fails the build on an import it cannot resolve, and
      // the import-x resolver does not understand the bundler module setting.
      'import-x/no-unresolved': 'off',
      // `null` is part of JSON and React, and every data source here speaks JSON.
      'unicorn/no-null': 'off',
      // Keep the rule, but allow the short words every Node and React codebase
      // uses, inside compound names too (configDir, readProps).
      'unicorn/prevent-abbreviations': [
        'error',
        {
          replacements: {
            props: false,
            args: false,
            params: false,
            env: false,
            dir: false,
            dirs: false,
            ref: false,
            refs: false,
            src: false,
          },
        },
      ],
      // Overlord runs the user's own git and claude binaries, which are found
      // on PATH by design.
      'sonarjs/no-os-command-from-path': 'off',
      // `n` does not understand bundling. import-x/no-extraneous-dependencies
      // (below) is what keeps dev dependencies out of shipped code.
      'n/no-unpublished-import': 'off',
      // noUncheckedIndexedAccess already makes every index read return
      // `T | undefined`, and this rule flags every `obj[key]` with no way to
      // tell safe access from unsafe.
      'security/detect-object-injection': 'off',
      // The whole extension reads user config files at paths built from HOME
      // and the workspace, so this rule would flag every fs call.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/host/**/*.ts', 'src/hook/**/*.ts', 'scripts/**', 'test/**'],
    ...n.configs['flat/recommended-module'],
    languageOptions: { globals: globals.node },
    rules: {
      ...n.configs['flat/recommended-module'].rules,
      // TypeScript resolves imports, and `n` cannot see bundler resolution.
      'n/no-missing-import': 'off',
      // vscode is provided by the editor at runtime, not by package.json.
      'n/no-extraneous-import': ['error', { allowModules: ['vscode'] }],
      // See the note on the same rule above.
      'n/no-unpublished-import': 'off',
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts', 'src/hook/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vscode', message: 'core, shared and hook code must not import vscode.' },
          ],
        },
      ],
    },
  },
  {
    files: ['webview/**/*.ts', 'webview/**/*.tsx'],
    ...react.configs.flat.recommended,
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: globals.browser,
    },
    settings: { react: { version: 'detect' } },
  },
  { files: ['webview/**/*.tsx'], ...react.configs.flat['jsx-runtime'] },
  { files: ['webview/**/*.tsx'], ...reactHooks.configs.flat['recommended-latest'] },
  { files: ['webview/**/*.tsx'], ...jsxA11y.flatConfigs.strict },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'test/**/*.ts'],
    ...vitest.configs.recommended,
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/consistent-test-it': ['error', { fn: 'it' }],
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/prefer-strict-equal': 'error',
      'vitest/require-top-level-describe': 'error',
      // Test files hold many small cases, so the file length cap is too tight.
      'max-lines': 'off',
      // Test names repeat on purpose (same case, different input).
      'sonarjs/no-duplicate-string': 'off',
      // Tests build fixture trees under the OS temp dir on purpose.
      'sonarjs/publicly-writable-directories': 'off',
    },
  },
  {
    files: ['test/integration/**/*.ts'],
    rules: {
      // Integration tests run under mocha inside VS Code, not vitest.
      'vitest/require-top-level-describe': 'off',
      'vitest/expect-expect': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node,
      // Plain JS files are not in a tsconfig, so they parse without type info.
      parserOptions: { projectService: false, project: null },
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    rules: {
      // Plain JavaScript has no return type syntax.
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: [
      '*.config.ts',
      '*.config.mts',
      '*.config.mjs',
      'webview/vite.config.ts',
      'eslint.config.mjs',
      '.dependency-cruiser.cjs',
      'stryker.config.mjs',
      '.vscode-test.mjs',
      'knip.config.ts',
    ],
    rules: {
      // Tool config files must export a default object.
      'import-x/no-default-export': 'off',
      // Plugins export their configs both ways, and the default is the documented one.
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',
    },
  },
  prettier,
  {
    // eslint-config-prettier turns curly off, but "all" never conflicts with Prettier.
    rules: { curly: ['error', 'all'] },
  },
);
