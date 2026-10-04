import type { PoolClient } from 'pg';
import { consultar, consultarUno } from '../../db/transaccion.js';
import type { FilaCatalogo, FilaCatalogoConUsos } from './modelo.js';

/**
 * SQL del catalogo.
 *
 * IMPORTANTE: los identificadores de tabla y columna se reciben como
 * parametro, NUNCA vienen de la peticion. No hay forma de inyectarlos en
 * un string: el unico origen posible son las constantes de RECURSOS y de
 * la tabla de migraciones. Si alguna vez se acepta una tabla desde fuera,
 * esto deja de ser una lectura y se convierte en un DROP TABLE.
 *
 * Por lo demas es SQL boring: id + nombre, sin joins, mas un conteo de
 * usos que es un subquery por tabla referenciante.
 */

export interface DefinicionRecurso {
  /** Nombre real de la tabla. Constante del codigo, nunca del cliente. */
  tabla: string;
  /** Como se llama el recurso en los mensajes de error. */
  singular: string;
  plural: string;
  /** Tablas que lo referencian, para poder explicar un borrado que no se deja. */
  usos: readonly { etiqueta: string; tabla: string; columna: string }[];
}

/**
 * El catalogo completo, en un solo lugar.
 *
 * Agregar un recurso aqui (por ejemplo, cuando lleguen los alarmedores)
 * es agregar una entrada, no escribir otro repositorio.
 */
export const RECURSOS = {
  especies: {
    tabla: 'especies',
    singular: 'La especie',
    plural: 'las especies',
    usos: [
      { etiqueta: 'producto', tabla: 'productos', columna: 'especie_id' },
      { etiqueta: 'cliente', tabla: 'clientes', columna: 'especie_id' },
    ],
  },
  categorias: {
    tabla: 'categorias_producto',
    singular: 'La categoría',
    plural: 'las categorías',
    usos: [{ etiqueta: 'producto', tabla: 'productos', columna: 'categoria_id' }],
  },
} as const satisfies Record<string, DefinicionRecurso>;

export type ClaveRecurso = keyof typeof RECURSOS;

/**
 * Ordenar por nombre con la colacion de espanol.
 *
 * Sin esto, ORDER BY usa el orden de bytes de PostgreSQL: las vocales
 * acentuadas se van al final y la Ñ despues de la Z. En un catalogo que
 * se mira en cada venta eso se nota enseguida.
 *
 * La colacion pos.es_es la crea la migracion 0004 con ICU, no con la
 * locale del sistema operativo, para que el orden sea el mismo en
 * cualquier maquina donde se instale esto.
 *
 * La tabla va con alias porque `nombre` solo, sin calificar, es ambiguo
 * en cuanto el conteo de usos mete un subquery en la misma consulta.
 */
const ORDEN = `ORDER BY c.nombre COLLATE pos.es_es ASC`;

/**
 * El conteo de usos como una sola expresion SQL.
 *
 * Un subquery por tabla referenciante, sumando. Se hace asi y no con un
 * JOIN + GROUP BY porque cada recurso tiene un numero distinto de tablas
 * que lo apuntan (una la categoria, dos la especie) y porque el JOIN
 * obligaria a mirar dos veces la misma fila: con el subquery, listar las
 * doce categorias del catalogo son doce conteos y no doce filas de join.
 *
 * Los identificadores salen de `RECURSOS`, que es una constante del
 * codigo (ver la nota de seguridad de este archivo).
 */
function usosDe(recurso: DefinicionRecurso): string {
  const partes = recurso.usos.map(
    (uso) => `(SELECT count(*)::int FROM ${uso.tabla} WHERE ${uso.columna} = c.id)`,
  );
  return partes.length > 0 ? partes.join(' + ') : '0';
}

export async function listar(
  cliente: PoolClient,
  recurso: DefinicionRecurso,
): Promise<FilaCatalogoConUsos[]> {
  return consultar<FilaCatalogoConUsos>(
    cliente,
    `SELECT c.id, c.nombre, ${usosDe(recurso)} AS usos
       FROM ${recurso.tabla} c
       ${ORDEN}`,
  );
}

export async function obtener(
  cliente: PoolClient,
  recurso: DefinicionRecurso,
  id: number,
): Promise<FilaCatalogo | null> {
  return consultarUno<FilaCatalogo>(
    cliente,
    `SELECT id, nombre FROM ${recurso.tabla} WHERE id = $1`,
    [id],
  );
}

export async function crear(
  cliente: PoolClient,
  recurso: DefinicionRecurso,
  nombre: string,
): Promise<FilaCatalogo> {
  const fila = await consultarUno<FilaCatalogo>(
    cliente,
    `WITH nuevo AS (
       INSERT INTO ${recurso.tabla} (nombre) VALUES ($1) RETURNING id, nombre
     )
     SELECT id, nombre FROM nuevo`,
    [nombre],
  );
  // El RETURNING siempre trae la fila; el null solo viene del tipo.
  if (!fila) throw new Error('El INSERT del catalogo no devolvio fila');
  return fila;
}

export async function renombrar(
  cliente: PoolClient,
  recurso: DefinicionRecurso,
  id: number,
  nombre: string,
): Promise<boolean> {
  const { rows } = await cliente.query<{ id: number }>(
    `UPDATE ${recurso.tabla} SET nombre = $2 WHERE id = $1 RETURNING id`,
    [id, nombre],
  );
  return rows.length > 0;
}

/**
 * Cuenta en cuantos lugares se usa un registro.
 *
 * Se consulta ANTES de borrar para poder responder "la usan 3 clientes y
 * 12 productos" en vez de un error generico de clave foranea. Los FK de
 * estas tablas NO tienen ON DELETE, asi que si se borra a ciegas Postgres
 * avienta un 23503 que el usuario no entiende nada.
 */
export async function contarUsos(
  cliente: PoolClient,
  recurso: DefinicionRecurso,
  id: number,
): Promise<{ etiqueta: string; total: number }[]> {
  const conteos = await Promise.all(
    recurso.usos.map(async (uso) => {
      const { rows } = await cliente.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM ${uso.tabla} WHERE ${uso.columna} = $1`,
        [id],
      );
      return { etiqueta: uso.etiqueta, total: rows[0]?.total ?? 0 };
    }),
  );
  return conteos.filter((c) => c.total > 0);
}
