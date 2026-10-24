import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests only. The rest of the studio's tests run under plain `node --test tests/*.test.mjs`.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/components/**/*.test.tsx'],
    environment: 'happy-dom',
    setupFiles: ['tests/components/setup.ts'],
  },
});
