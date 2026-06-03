import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['node_modules/**', 'dist/**', 'backups/**'],
    setupFiles: ['./src/services/__tests__/setup-env.ts'],
  },
});
