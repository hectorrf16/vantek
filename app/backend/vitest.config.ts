/**
 * ──────────────────────────────────────────────────────────────────────────────
 * vitest.config.ts — Backend test runner configuration
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Configures Vitest for the backend: node environment, the TS path aliases
 *   (mirrors tsconfig.json) so services/db resolve under test, a setup file that
 *   points VANTEK_ROOT at a throwaway temp install and runs migrations, and
 *   per-file isolation so each test file gets its own SQLite database.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · vitest/config (defineConfig) → typed config helper
 *     · node:path, node:url → absolute alias targets
 *   Used by:
 *     · `vitest` CLI via `npm test` in app/backend
 *
 * NOTES
 *   · Aliases MUST stay in sync with tsconfig.json paths.
 *   · isolate:true + a fresh VANTEK_ROOT per file keeps DBs from colliding.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');

export default defineConfig({
  resolve: {
    alias: {
      '@db': path.join(src, 'db'),
      '@routes': path.join(src, 'routes'),
      '@services': path.join(src, 'services'),
      '@middleware': path.join(src, 'middleware'),
      '@utils': path.join(src, 'utils'),
      '@types-app': path.join(src, 'types', 'index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    isolate: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    pool: 'forks',
    // Medición de cobertura (npm run test:coverage). Los umbrales están al
    // nivel actual: sirven para que la cobertura no BAJE, no como objetivo.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/services/**', 'src/utils/**', 'src/db/**'],
      thresholds: { lines: 35, functions: 40, statements: 35, branches: 55 },
    },
  },
});
