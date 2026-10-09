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
 * El dia de HOY segun la base, como `AAAA-MM-DD`.
 *
 * Vive aqui y no en el reloj de Node a proposito: la fecha que se guarda es
 * la del servidor de la base, y entre las dos puede haber una diferencia de
 * un dia (o de unas horas, si la maquina esta mal sincronizada). En un
 * negocio que cierra caja por la noche, un pago de las 11 de la noche
 * guardado con el dia de manana es un descuadre que aparece al cierre.
 *
 * Ademas devuelve texto y no `Date` a proposito: es lo que se manda a la
 * base y lo que sale por la API, y convertirlo en un `Date` en el camino
 * reintroduce el corrimiento de huso horario que `fechaComoTexto` existe
 * para evitar.
 */
export async function hoyEnLaBase(cliente: PoolClient): Promise<string> {
  const fila = await consultarUno<{ hoy: string }>(
    cliente,
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hoy`,
  );
  return fila?.hoy ?? '';
}

/**
 * El momento actual segun la base, como `AAAA-MM-DD HH:MM`.
 *
 * Hermano de `hoyEnLaBase` y por el mismo motivo: la hora del servidor de la
 * base es la que vale, no la de Node. Se usa para el sello del cierre de caja,
 * donde "hasta ahora" tiene que salir del mismo reloj que las fechas.
 *
 * Se devuelve ya en texto porque es lo que se muestra tal cual en la pantalla,
 * sin pasar por `Date` y sin el corrimiento de huso horario.
 */
export async function momentoEnLaBase(cliente: PoolClient): Promise<string> {
  const fila = await consultarUno<{ ahora: string }>(
    cliente,
    `SELECT to_char(now(), 'YYYY-MM-DD HH24:MI') AS ahora`,
  );
  return fila?.ahora ?? '';
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
