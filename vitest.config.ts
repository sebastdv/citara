import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // swc reemplaza el transform por defecto (esbuild) porque esbuild no
  // implementa "emitDecoratorMetadata": las entidades de TypeORM dependen
  // de esa metadata para inferir el tipo de columna desde el tipo TS.
  plugins: [swc.vite()],
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
