import type { PoolClient } from 'pg';
import { pool } from './pool.js';

/**
 * Todo el SQL parametrizado pasa por aqui.
 *
 * NUNCA concatenar valores en el texto: siempre $1, $2, ... Un
 * `WHERE nombre = '${req.query.nombre}'` es una inyeccion esperando a
 * que alguien escriba una comilla.
 */
export async function consultar<T>(
  cliente: PoolClient,
  texto: string,
  valores: readonly unknown[] = [],
): Promise<T[]> {
  const resultado = await cliente.query(texto, valores as unknown[]);
  return resultado.rows as T[];
}

export async function consultarUno<T>(
  cliente: PoolClient,
  texto: string,
  valores: readonly unknown[] = [],
): Promise<T | null> {
  const filas = await consultar<T>(cliente, texto, valores);
  return filas[0] ?? null;
}

export async function contar(
  cliente: PoolClient,
  texto: string,
  valores: readonly unknown[] = [],
): Promise<number> {
  const fila = await consultarUno<{ total: number }>(cliente, texto, valores);
  return Number(fila?.total ?? 0);
}

/**
 * Unidad de trabajo: todo lo que hay dentro es una sola transaccion.
 * Si la funcion lanza, ROLLBACK; si termina, COMMIT.
 *
 * Se usa cuando dos escrituras tienen que ocurrir juntas o no ocurrir.
 * Ejemplo: una nota de remision y sus movimientos de inventario. Ojo:
 * si estas dentro de una peticion que ya tiene su propio cliente
 * (req.db), usa ese cliente en vez de abrir otra conexion del pool,
 * porque si no el COMMIT no incluye lo que hizo el trigger.
 */
export async function enTransaccion<T>(trabajo: (cliente: PoolClient) => Promise<T>): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => {
      // Si la conexion murio durante el trabajo, el ROLLBACK tambien
      // falla. El error original es el que importa.
    });
    throw error;
  } finally {
    cliente.release();
  }
}

/**
 * Transaccion sobre el cliente que YA tiene abierto el request, para que
 * el COMMIT incluya lo que hicieron los triggers. Si la peticion va a
 * escribir, esta es la que se usa.
 */
export async function enTransaccionDe<T>(
  cliente: PoolClient,
  trabajo: (c: PoolClient) => Promise<T>,
): Promise<T> {
  await cliente.query('BEGIN');
  try {
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => {
      /* ver nota en enTransaccion */
    });
    throw error;
  }
}
