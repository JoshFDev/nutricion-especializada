import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default tseslint.config(
  {
    // Que no se linten los compilados ni las dependencias.
    ignores: ['dist/**', '.angular/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      // `no-undef` no sirve con TypeScript: el compilador ya sabe que
      // `document` existe y ESLint no, y con las plantillas de Angular
      // avisa de cosas que si existen. El resto de los defaults siguen
      // puestos.
      'no-undef': 'off',

      // Un `any` explicito se tolera en los limites (el `catch` de una
      // promesa, el cuerpo crudo de una respuesta), pero el aviso obliga a
      // que sea a proposito y no por prisa.
      '@typescript-eslint/no-explicit-any': 'warn',

      // `import type` para lo que solo son tipos: sin esto, un archivo de
      // tipos se compila dentro del bundle aunque no se use en runtime.
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      // El `autofocus` se apaga, pero NO en todas partes: en el login se
      // deja a proposito (ver la nota de `login.html`) y se enciende en el
      // resto, que es donde si estorba.
      '@angular-eslint/template/no-autofocus': 'error',
    },
  },
  {
    files: ['src/app/auth/login.html'],
    rules: {
      // En una pantalla de login el foco tiene que ir al correo: es lo
      // primero que escribe siempre la gente y el campo de contrasena nunca
      // es lo primero. El problema que la reglapreviene (que el foco salte
      // solo y desoriente a quien usa lector de pantalla) aqui no aplica,
      // porque la pantalla tiene dos campos y un boton, y el orden de tab
      // es exactamente el que la persona espera.
      //
      // Si esta excepcion se extiende a otra pantalla, el autofocus se
      // corrige: en una tabla de renglones si hace dano de verdad.
      '@angular-eslint/template/no-autofocus': 'off',
    },
  },
);
