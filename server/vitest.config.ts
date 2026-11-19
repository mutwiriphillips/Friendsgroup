import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.ts'],
    fileParallelism: false, // tests share one database
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://savings:savings@localhost:5432/savings_test',
      JWT_SECRET: 'test-jwt-secret-0123456789-0123456789',
      FIELD_ENCRYPTION_KEY: '11'.repeat(32),
    },
  },
});
