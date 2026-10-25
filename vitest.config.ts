import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests only. The rest of the studio's tests run under plain `node --test tests/*.test.mjs`.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/components/**/*.test.tsx'],
    environment: 'happy-dom',
    // Full-layout tests are memory-heavy; bound concurrency without weakening timeouts or isolation.
    maxWorkers: 4,
    setupFiles: ['tests/components/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['downbeat/studio/src/components/**/*.{ts,tsx}', 'downbeat/studio/src/App.tsx', 'downbeat/studio/src/state/workspaceStore.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'artifacts/coverage/components',
      thresholds: { statements: 90, branches: 83, functions: 90, lines: 92 },
    },
  },
});
