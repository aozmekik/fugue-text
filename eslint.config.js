// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'examples/**/bundle/', 'bench/out/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Conflicts with no-non-null-assertion (strict): prefer explicit `as T` narrowing.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      eqeqeq: 'error',
      'no-console': 'error',
    },
  },
  {
    // Every exported declaration of the library carries a doc comment.
    files: ['src/**/*.ts'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            ClassDeclaration: true,
            FunctionDeclaration: true,
            MethodDefinition: true,
          },
          contexts: ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSPropertySignature'],
          checkConstructors: false,
        },
      ],
      'jsdoc/check-tag-names': ['error', { definedTags: ['internal', 'packageDocumentation'] }],
    },
  },
  {
    // Tests, benchmarks and examples may print and use non-null assertions sparingly.
    files: ['test/**/*.ts', 'bench/**/*.ts', 'examples/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  { files: ['**/*.js', '**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
