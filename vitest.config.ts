import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Independent repository snapshot generated for external Preview QA.
    exclude: [...configDefaults.exclude, '.omx/qa/external-preview-v1/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
