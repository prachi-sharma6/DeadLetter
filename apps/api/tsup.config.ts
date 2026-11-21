import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Only our workspace packages (shipped as TypeScript source) are bundled. Every npm package stays external and is
  // loaded from node_modules at runtime: bundling Prisma's client breaks it (dynamic requires + engine binaries).
  skipNodeModulesBundle: true,
  noExternal: [/^@deadletter\//],
});
