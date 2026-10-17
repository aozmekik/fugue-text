import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: { compilerOptions: { types: [] } },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
