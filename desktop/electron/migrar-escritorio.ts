import pg from 'pg';
import { aplicarMigracionesPendientes } from './migraciones.js';

/**
 * Aplica las migraciones que falten al arrancar la aplicacion.
 *
 * El trabajo de verdad (leer archivos, limpiar SQL, abrir transacciones) vive
 * en `migraciones.ts`, porque la restauracion de un respaldo usa los mismos
 * archivos. Aqui solo se abre y se cierra la conexion.
 */
export async function aplicarMigracionesEscritorio(config: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}) {
  const cliente = new pg.Client({ ...config, client_encoding: 'UTF8' });
  await cliente.connect();

  try {
    await aplicarMigracionesPendientes(cliente);
  } finally {
    await cliente.end();
  }
}
