import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * ESLint en modo "flat config" (el de ESLint 9 y 10).
 *
 * La diferencia importante con el modo viejo es que ya no hay .eslintrc
 * ni la palabra "extends": aqui todo es una lista de objetos que se
 * aplican en orden, y lo que se pone AL FINAL gana. Por eso
 * eslint-config-prettier va el ultimo: apaga las reglas de formato que
 * daria ESLint para que no pelee con Prettier.
 *
 * El orden importa: si prettier fuera antes, las reglas de estilo de
 * typescript-eslint volverian a activarse y tendriamos dos herramientas
 * corrigiendo lo mismo.
 */
export default tseslint.config(
  {
    // Lo que no se revisa. dist/ es codigo compilado y volveria a
    // escupir errores de formato que ya arreglo el compilador.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.d.ts'],
  },

  // Reglas base de JavaScript, para todo el proyecto.
  js.configs.recommended,

  // TypeScript, SOLO sobre src/. En el resto (tests, archivos de
  // configuracion) se usan las reglas simples de mas abajo porque las
  // reglas que necesitan informacion de tipos fallan si el archivo no
  // esta en un tsconfig.
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      // Este paquete obliga a tipar las promesas que se disparan sin
      // await. En Express 5 es lo que evita que un rejection se pierda
      // en silencio y la peticion se quede colgada para siempre.
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // projectService encuentra el tsconfig correcto de cada archivo
        // solo, en vez de tener que apuntarlo a mano.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // En un proyecto CRUD hay muchisimos DTOs y mapeos de una linea.
      // Obligar a tiparlos explicitamente seria ruido sin Facilitar. Aqui solo
      // avisamos cuando el tipo se deduce de forma distinta a la
      // declarada.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Un `any` explicito se prohibe: si el tipo es desconocido, el
      // problema se esconde mejor asi que en el any. El `unknown` obliga
      // a revisar el valor antes de usarlo.
      '@typescript-eslint/no-explicit-any': 'error',
      // Los parametros sin usar se marcan con _ y no se avisa.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Para lo que no es src (tests, .mjs): reglas de JS sin tipos.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // Sin esto, `console`, `process` y `fetch` aparecen como "no
      // definidos": el flat config no trae los globals de Node por su
      // cuenta, hay que declararlos a mano.
      globals: { ...globals.node },
    },
  },

  // ESTE VA DE ULTIMO. Desactiva todas las reglas de formato de ESLint
  // porque el formato lo manda Prettier. Si lo mueves antes de aqui,
  // las dos herramientas se pelean por el mismo codigo.
  prettier,
);
