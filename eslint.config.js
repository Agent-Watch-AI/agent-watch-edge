import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import jsdoc from 'eslint-plugin-jsdoc';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      '@stylistic': stylistic,
      'import-x': importX,
      jsdoc
    },
    rules: {
      // Functional style & control flow: absolute ban on 'else' / 'else if'.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'IfStatement[alternate]',
          message: 'Do not use "else" or "else if". Use early returns (guard clauses) or ternary expressions.'
        },
        {
          // STYLEGUIDE 3.4: `delete obj.key` transitions the object to
          // dictionary mode and deoptimizes every access site that shares its
          // hidden class. Build a new object without the key instead
          // (see omitKeys in src/core/object.ts).
          selector: 'UnaryExpression[operator="delete"]',
          message: 'Do not use "delete" (V8 hidden-class deopt). Build a new object without the key — see omitKeys() in src/core/object.ts.'
        }
      ],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-lonely-if': 'error',
      'no-nested-ternary': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      // Pure functions: never mutate what was handed to you.
      'no-param-reassign': ['error', { props: true }],

      // TypeScript specific
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true
        }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      'import-x/no-duplicates': 'error',

      // Formatting & newlines (padding lines)
      '@stylistic/padding-line-between-statements': [
        'error',
        // Always require blank lines before returns
        { blankLine: 'always', prev: '*', next: 'return' },
        // Always require blank lines before conditionals and loops
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'switch', 'try', 'do'] },
        // Always require blank lines after conditionals and loops
        { blankLine: 'always', prev: ['if', 'for', 'while', 'switch', 'try', 'do'], next: '*' },
        // Blank line after declarations block
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
        // Blank line after directive prologues
        { blankLine: 'always', prev: 'directive', next: '*' },
        { blankLine: 'any', prev: 'directive', next: 'directive' }
      ],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],

      // Documentation (JSDoc).
      //
      // Scoped to the public surface, matching STYLEGUIDE 5 ("document every
      // exported function and interface"). Private helpers carry a comment
      // when the *why* is not obvious and stay bare when they are; a rule that
      // demanded a block on every local helper produced 171 empty
      // `/** */` stubs, which is strictly worse than no doc at all.
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false
          },
          contexts: [
            'ExportNamedDeclaration > FunctionDeclaration',
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression'
          ]
        }
      ],
      'jsdoc/require-description': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': 'error',
      'jsdoc/no-blank-blocks': 'error',
      'jsdoc/empty-tags': 'error',

      // Console
      'no-console': ['error', { allow: ['error'] }]
    }
  },
  {
    // Type declarations are the contract, not the logic: no runtime code, so
    // the statement-padding and JSDoc-on-every-export rules do not apply.
    files: ['src/**/types/*.types.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off'
    }
  },
  {
    files: ['tests/**', 'example/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-restricted-syntax': 'off',
      'jsdoc/require-jsdoc': 'off'
    }
  }
);
