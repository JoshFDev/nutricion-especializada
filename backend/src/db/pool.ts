import pg from 'pg';
import { env } from '../config/entorno.js';

const { Pool } = pg;

/**
 * Un unico pool para toda la aplicacion.
 *
 * `options` fija el search_path de cada conexion recien abierta. Sin esto
 * habria que calificar cada tabla como pos.clientes, o hacer SET por
 * peticion; ademas los triggers y funciones de la base asumen el schema
 * `pos` y no lo busca en ningun otro lado.
 */
export const pool = new Pool({
  host: env.PGHOST,
  port: env.PGPORT,
  database: env.PGDATABASE,
  user: env.PGUSER,
  password: env.PGPASSWORD,
  max: env.DB_MAX_CONEXIONES,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  options: `-c search_path=${env.DB_SCHEMA},public`,
  application_name: 'api-nutricion',
});

pool.on('error', (error) => {
  // Un cliente que se cae sin cerrar deja un socket muerto en el pool.
  // Sin este listener, ese 'error' sin manejar tumba el proceso entero.
  console.error('Error inesperado en el pool de PostgreSQL:', error.message);
});

/** Cierra el pool. Se llama al apagar el servidor para no dejarlo colgado. */
export const cerrarPool = (): Promise<void> => pool.end();

/** El pool esta vivo? Lo usa /api/salud para distinguir API caida de base caida. */
export async function baseViva(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
