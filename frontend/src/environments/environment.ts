/**
 * Valores de la app cuando ya está publicada.
 *
 * La dirección del servicio va RELATIVA a propósito: en producción el mismo
 * servidor (nginx) entrega el archivo de la app y `/api`, así que el navegador
 * no tiene motivo para bloquear la conexión: todo sale del mismo lugar, sin un
 * segundo origen que alguien pueda meter entre el navegador y el sistema.
 *
 * En desarrollo se usa la dirección completa (ver `environment.development.ts`),
 * que es lo que hace falta porque `ng serve` vive en el puerto 4200 y el
 * sistema en el 3000. El sistema ya trae `http://localhost:4200` en la lista
 * blanca de `CORS_ORIGINS`, así que las dos piezas se hablan sin cambiar nada.
 */
export const environment = {
  produccion: true,
  api: '/api',
};
