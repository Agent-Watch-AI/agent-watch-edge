import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // No runtime logic to cover: type declarations, constant tables, zod
      // schemas and the barrels nothing imports. Counting them inflates the
      // number and hides the thing the threshold is for.
      exclude: ['src/**/types/*.ts', 'src/**/constants/*.ts', 'src/**/schemas/*.ts', 'src/**/index.ts'],
      thresholds: {
        // "485 tests pass" is not an answer to "what fraction of the
        // enforcement path is exercised", and that is the question an
        // enterprise review asks in writing. The floors are per directory
        // because the four that matter are not the four that are easiest.
        // Set a few points under what the suite actually covers today, so a
        // regression fails and a legitimate refactor does not.
        'src/privacy/**': { statements: 98, branches: 88, functions: 100, lines: 98 },
        'src/enforcement/**': { statements: 90, branches: 86, functions: 95, lines: 90 },
        'src/transport/**': { statements: 92, branches: 84, functions: 95, lines: 92 },
        'src/turns/**': { statements: 94, branches: 86, functions: 95, lines: 94 }
      }
    }
  }
});
