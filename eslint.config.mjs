// ─────────────────────────────────────────────────────────────────────────────
// eslint.config.mjs — Configuración de lint del monorepo (flat config)
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT IT DOES
//   Adds the static gate the project never had: unused code, obvious mistakes
//   and React hook dependency errors (exactly the class of bug behind the
//   autosave stale-closure). Deliberately NOT type-aware, so `npm run lint`
//   stays fast and does not duplicate what `tsc --noEmit` already checks.
//
// RELATIONSHIPS
//   Used by: package.json → `npm run lint`; .github/workflows/ci.yml
//
// NOTES
//   · Formatting is Prettier's job (.prettierrc); this file only checks code.
// ─────────────────────────────────────────────────────────────────────────────

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'launcher/launcher.js',
      'app/frontend/public/**',
      'release/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // El código usa `any` de forma deliberada en las filas de SQLite y en el
      // launcher sin dependencias: se avisa, no se bloquea.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: ['app/frontend/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Aviso, no error: hay efectos con dependencias omitidas a propósito
      // (autosave, carga por id) que están documentados en su comentario.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // El launcher es CommonJS puro sin dependencias: usa require() y globales
    // de Node que la config base no conoce.
    files: ['launcher/**/*.ts', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  }
);
