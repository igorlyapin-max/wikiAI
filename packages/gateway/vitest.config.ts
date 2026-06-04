import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['node_modules/**', 'dist/**'],
    setupFiles: ['./src/services/__tests__/setup-env.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
      thresholds: {
        statements: 75,
        branches: 60,
        functions: 80,
        lines: 78,
      },
    },
  },
});
