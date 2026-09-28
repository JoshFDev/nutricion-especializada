/**
 * Valores de la app en produccion.
 *
 * La API va RELATIVA a proposito: en produccion el mismo nginx sirve el
 * archivo de Angular y `/api`, asi que no hay ni CORS ni preflight ni un
 * segundo origen que alguien pueda meter entre el navegador y el backend.
 *
 * En desarrollo se usa la direccion completa (ver `environment.development.ts`),
 * que es lo que hace falta porque `ng serve` vive en el puerto 4200 y el
 * backend en el 3000. El backend ya trae `http://localhost:4200` en la lista
 * blanca de `CORS_ORIGINS`, asi que las dos piezas se hablan sin cambiar nada.
 */
export const environment = {
  produccion: true,
  api: '/api',
};
