import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // See apps/api/tsup.config.ts: bundle workspace packages only, keep npm packages external.
  skipNodeModulesBundle: true,
  noExternal: [/^@deadletter\//],
});
