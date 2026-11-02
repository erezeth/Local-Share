'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', 'pnpm-lock.yaml'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-empty': 'error',
      'no-throw-literal': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.js', 'server.js', 'eslint.config.js', 'test/**/*.js', 'test-support/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        // Node 24 exposes these Web APIs globally; CommonJS imports intentionally shadow them.
        crypto: 'off',
        WebSocket: 'off',
      },
    },
  },
  {
    files: ['src/security.js', 'public/app.js'],
    rules: {
      // Control characters are deliberately stripped from user input.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
