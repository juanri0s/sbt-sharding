import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.config.ts',
        '**/*.config.js',
        '**/test/**',
        '**/*.test.ts',
      ],
      // Exclude the entry point that only runs in GitHub Actions
      all: false,
      thresholds: {
        lines: 98.46,
        functions: 100,
        branches: 97.54, // Minimum threshold, but always strive for 100%
        statements: 98.51,
      },
    },
  },
});
