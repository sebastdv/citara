import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import swc from 'unplugin-swc';

export default defineConfig({
  // Los paquetes del workspace publican `main` apuntando a `dist`, que es lo
  // correcto para producción: Node no sabe ejecutar TypeScript. Pero en pruebas
  // eso obligaría a compilar antes de cada corrida y a depurar sobre el build.
  // Estos alias hacen que los tests lean el FUENTE, que es lo que se está
  // editando, mientras `main` sigue siendo correcto para arrancar de verdad.
  resolve: {
    alias: {
      '@citara/db': resolve(__dirname, 'packages/db/src/index.ts'),
      '@citara/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@citara/api': resolve(__dirname, 'apps/api/src/index.ts'),
    },
  },
  // swc reemplaza el transform por defecto (esbuild) porque esbuild no
  // implementa "emitDecoratorMetadata": las entidades de TypeORM dependen
  // de esa metadata para inferir el tipo de columna desde el tipo TS.
  plugins: [swc.vite()],
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Varios archivos de test corren migraciones (`runMigrations()`) contra
    // el mismo Postgres compartido en su `beforeAll`. En paralelo compiten
    // por crear las mismas tablas/filas de `migrations` a la vez. Los test
    // files corren en serie para que esas migraciones no compitan entre sí.
    fileParallelism: false,
  },
});
