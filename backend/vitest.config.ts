import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Solo los tests unitarios de tests/unit. El archivo tests/api.test.mjs
    // NO entra aqui a proposito: es un script de integracion que necesita
    // el servidor arriba y una base de datos, y termina con process.exit(),
    // cosa que Vitest reporta como error.
    include: ['tests/unit/**/*.test.ts'],

    // Un test que se cuelga es peor que uno que falla: aqui se corta a los
    // 5 segundos para que un await colgado no te tenga esperando horas.
    testTimeout: 5_000,
  },
});
