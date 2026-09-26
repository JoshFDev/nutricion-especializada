import pg from 'pg';
import { env } from '../config/entorno.js';

const { Pool } = pg;

/**
 * Un solo pool para toda la app.
 *
 * `options` fija el search_path de cada conexion recien abierta. Sin esto
 * habria que calificar cada tabla como pos.clientes, o hacer SET por
 * conexion; ademas los triggers de la base asumen el schema `pos`.
 */
export const pool = new Pool({
  host: env.PGHOST,
  port: env.PGPORT,
  database: env.PGDATABASE,
  user: env.PGUSER,
  password: env.PGPASSWORD,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  options: `-c search_path=${env.DB_SCHEMA},public`,
});

pool.on('error', (error) => {
  // Un cliente que se cae sin cerrar deja un socket muerto en el pool.
  console.error('Error inesperado en el pool de PostgreSQL:', error.message);
});

/**
 * Consulta parametrizada. NUNCA concatenar valores en el SQL: siempre $1, $2...
 * Un `WHERE id = '${req.params.id}'` es una inyeccion esperando a ocurrir.
 */
export async function consultar<T>(
  texto: string,
  valores: unknown[] = [],
): Promise<T[]> {
  const resultado = await pool.query(texto, valores);
  return resultado.rows as T[];
}

export async function consultarUno<T>(
  texto: string,
  valores: unknown[] = [],
): Promise<T | null> {
  const filas = await consultar<T>(texto, valores);
  return filas[0] ?? null;
}

/**
 * Envuelve una unidad de trabajo en una transaccion. Si la funcion lanza,
 * se hace ROLLBACK; si termina, COMMIT.
 */
export async function enTransaccion<T>(
  trabajo: (cliente: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}

/**
 * Comprueba que la base responde. Se usa en /api/salud para que el
 * despliegue pueda distinguir "el API esta caido" de "la base esta caida".
 */
export async function baseViva(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
