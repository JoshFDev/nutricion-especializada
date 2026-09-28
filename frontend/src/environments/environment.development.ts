/**
 * Valores de la app en desarrollo.
 *
 * El puerto 3000 es el del backend (`pnpm dev` en `backend/`). Este archivo
 * se sustituye por `environment.ts` en el build de produccion, asi que la
 * direccion de desarrollo no llega a existir en el bundle que se publica.
 *
 * Este origen tiene que estar en `CORS_ORIGINS` del `.env` del backend. Con
 * `.env.example` viene bien de serie; si cambias el puerto del `ng serve`,
 * cambialo tambien alla.
 */
export const environment = {
  produccion: false,
  api: 'http://localhost:3000/api',
};
