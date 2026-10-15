/**
 * Valores de la app en desarrollo.
 *
 * El puerto 3000 es el del sistema (`pnpm dev` en `backend/`). Este archivo
 * se sustituye por `environment.ts` al armar la versión publicada, así que la
 * dirección de desarrollo no llega a existir en el paquete final.
 *
 * Este origen tiene que estar en `CORS_ORIGINS` del archivo `.env` del
 * sistema; si no, el navegador bloqueará la conexión. Con `.env.example`
 * viene bien de fábrica; si cambias el puerto del `ng serve`, cámbialo
 * también allá.
 */
export const environment = {
  produccion: false,
  api: 'http://localhost:3000/api',
};
