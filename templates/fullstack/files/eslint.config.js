import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', '.claude', '.factory'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['*.js'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: { '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }] },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  { files: ['server/**/*.ts'], languageOptions: { globals: globals.node }, rules: { 'no-console': 'error' } },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
);
