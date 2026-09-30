import type { PoolClient } from 'pg';
import { consultar, consultarUno } from '../../db/transaccion.js';
import type { FilaDireccion } from './modelo.js';

/**
 * SQL del catalogo de direcciones de entrega.
 *
 * Es el SQL mas boring que hay en el proyecto: una tabla, tres columnas y un
 * `ORDER BY`. Lo que si tiene una decision es el orden, y esta comentado
 * abajo.
 *
 * NO hay `contarUsos` como en `modules/catalogo`, y no es descuido: ahi el
 * borrado tiene que explicar "la usan 3 clientes y 12 productos" porque hay
 * FK que lo impiden. Aqui no hay ninguna FK, porque la nota guarda el TEXTO
 * de la direccion y no su id (ver la migracion 0011): borrar una direccion
 * no rompe nada, y por eso se puede borrar sin preguntar quien la usa.
 */

const COLUMNAS = `id, nombre, direccion`;

/**
 * Ordenar por nombre con la colacion de espanol.
 *
 * Sin esto, `ORDER BY` usa el orden de bytes de PostgreSQL: las vocales
 * acentuadas se van al final y la Ñ despues de la Z. Este catalogo se abre
 * varias veces al dia para elegir a donde va el camion, asi que el orden se
 * nota. La colacion `pos.es_es` la crea la migracion 0004 con ICU, no con
 * la locale del sistema operativo, para que sea el mismo en cualquier
 * maquina donde se instale esto.
 */
const ORDEN = `ORDER BY nombre COLLATE pos.es_es ASC, id ASC`;

export async function listar(cliente: PoolClient): Promise<FilaDireccion[]> {
  return consultar<FilaDireccion>(cliente, `SELECT ${COLUMNAS} FROM direcciones_entrega ${ORDEN}`);
}

export async function obtener(cliente: PoolClient, id: number): Promise<FilaDireccion | null> {
  return consultarUno<FilaDireccion>(
    cliente,
    `SELECT ${COLUMNAS} FROM direcciones_entrega WHERE id = $1`,
    [id],
  );
}

export async function crear(
  cliente: PoolClient,
  d: { nombre: string; direccion: string },
): Promise<FilaDireccion> {
  const fila = await consultarUno<FilaDireccion>(
    cliente,
    `INSERT INTO direcciones_entrega (nombre, direccion)
     VALUES ($1, $2)
     RETURNING ${COLUMNAS}`,
    [d.nombre, d.direccion],
  );
  // El RETURNING siempre trae la fila; el null solo viene del tipo.
  if (!fila) throw new Error('El INSERT de la direccion no devolvio fila');
  return fila;
}

export async function actualizar(
  cliente: PoolClient,
  id: number,
  d: { nombre: string; direccion: string },
): Promise<boolean> {
  const r = await consultar<{ id: number }>(
    cliente,
    `UPDATE direcciones_entrega
        SET nombre = $2, direccion = $3
      WHERE id = $1
      RETURNING id`,
    [id, d.nombre, d.direccion],
  );
  return r.length > 0;
}

export async function borrar(cliente: PoolClient, id: number): Promise<boolean> {
  const r = await consultar<{ id: number }>(
    cliente,
    `DELETE FROM direcciones_entrega WHERE id = $1 RETURNING id`,
    [id],
  );
  return r.length > 0;
}
