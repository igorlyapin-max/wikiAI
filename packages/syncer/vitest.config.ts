import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['node_modules/**', 'dist/**', 'backups/**'],
    setupFiles: ['./src/services/__tests__/setup-env.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'backups/', '**/*.test.ts'],
      thresholds: {
        statements: 78,
        branches: 60,
        functions: 82,
        lines: 80,
      },
    },
  },
});
