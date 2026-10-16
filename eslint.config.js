import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['templates/**/files/**', 'node_modules', 'coverage', '.factory'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: 'error',
      'prefer-const': 'error',
    },
  },
];
