import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['node_modules', 'tests/e2e/**', '.next', 'out'],
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
});
