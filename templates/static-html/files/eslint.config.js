import js from '@eslint/js';
import html from 'eslint-plugin-html';
import globals from 'globals';

export default [
  { ignores: ['node_modules', 'coverage', '_site', '.claude', '.factory', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  {
    files: ['**/*.html'],
    plugins: { html },
    languageOptions: { globals: globals.browser, sourceType: 'script' },
    rules: { 'no-unused-vars': 'error', eqeqeq: 'error', 'no-implied-eval': 'error' },
  },
  { files: ['**/*.js'], languageOptions: { globals: globals.node } },
];
