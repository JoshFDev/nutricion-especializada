import type { PoolClient } from 'pg';
import { Conflicto, NoEncontrado } from '../../core/errores.js';
import type { FilaCatalogo } from './modelo.js';
import { mapeoFila } from './modelo.js';
import * as repo from './repositorio.js';
import type { ClaveRecurso, DefinicionRecurso } from './repositorio.js';

/**
 * Reglas del catalogo.
 *
 * Especies y Categorias comparten servicio porque comparten tabla
 * (id + nombre). Lo que cambia entre una y otra son los mensajes, y eso
 * se resuelve con la definicion del recurso, no duplicando codigo.
 */

/** Traduce el 23505 de Postgres al 409 con un mensaje que si se entiende. */
const NOMBRE_DUPLICADO = (definicion: DefinicionRecurso, detalle: string): Conflicto =>
  new Conflicto('NOMBRE_DUPLICADO', `${definicion.singular} "${detalle}" ya existe en el catalogo`);

/**
 * El indice ux_*_nombre_ci de la migracion 0003 impide duplicados sin
 * distinguir mayusculas. Postgres avisa con 23505 y el nombre del indice
 * en el `constraint`; se leen los dos para no tener que adivinar.
 */
const esNombreDuplicado = (error: unknown): boolean =>
  (error as { code?: string })?.code === '23505';

const definicion = (clave: ClaveRecurso): DefinicionRecurso => repo.RECURSOS[clave];

/**
 * Listado con la MISMA forma que clientes y usuarios: { datos, total }.
 *
 * Estas tablas son chicas y podrian devolver un arreglo pelado, pero
 * entonces el frontend necesita un componente de lista aparte solo para
 * el catalogo. Uniformar la forma sale mas barato que mantener dos.
 */
export async function listar(
  db: PoolClient,
  clave: ClaveRecurso,
): Promise<{ datos: FilaCatalogo[]; total: number }> {
  const filas = await repo.listar(db, definicion(clave));
  const datos = filas.map(mapeoFila);
  return { datos, total: datos.length };
}

export async function obtener(
  db: PoolClient,
  clave: ClaveRecurso,
  id: number,
): Promise<FilaCatalogo> {
  const fila = await repo.obtener(db, definicion(clave), id);
  if (!fila) throw new NoEncontrado(`No existe ese registro en ${definicion(clave).plural}`);
  return mapeoFila(fila);
}

export async function crear(
  db: PoolClient,
  clave: ClaveRecurso,
  nombre: string,
): Promise<FilaCatalogo> {
  const def = definicion(clave);
  try {
    return mapeoFila(await repo.crear(db, def, nombre));
  } catch (error) {
    if (esNombreDuplicado(error)) throw NOMBRE_DUPLICADO(def, nombre);
    throw error;
  }
}

export async function renombrar(
  db: PoolClient,
  clave: ClaveRecurso,
  id: number,
  nombre: string,
): Promise<FilaCatalogo> {
  const def = definicion(clave);
  const antes = await repo.obtener(db, def, id);
  if (!antes) throw new NoEncontrado(`No existe ese registro en ${def.plural}`);

  try {
    const ok = await repo.renombrar(db, def, id, nombre);
    if (!ok) throw new NoEncontrado(`No existe ese registro en ${def.plural}`);
  } catch (error) {
    if (esNombreDuplicado(error)) throw NOMBRE_DUPLICADO(def, nombre);
    throw error;
  }

  return obtener(db, clave, id);
}

/**
 * Borrar.
 *
 * Estas tablas no tienen columna `activo`, asi que no hay "dar de baja":
 * o se borra o no se toca. Y no se puede borrar lo que ya se uso, porque
 * los FK no tienen ON DELETE y Postgres soltaria un 23503 seco.
 *
 * En vez de eso se cuenta primero y se explica: "la usan 3 clientes y 12
 * productos". Eso deja claro que el registro no se puede quitar sin
 * arreglar antes lo que lo apunta, que es justo lo que paso de verdad si
 * se le deja a alguien!.
 */
export async function borrar(db: PoolClient, clave: ClaveRecurso, id: number): Promise<void> {
  const def = definicion(clave);

  const actual = await repo.obtener(db, def, id);
  if (!actual) throw new NoEncontrado(`No existe ese registro en ${def.plural}`);

  const usos = await repo.contarUsos(db, def, id);
  if (usos.length > 0) {
    const detalle = usos
      .map((u) => `${u.total} ${u.etiqueta}${u.total === 1 ? '' : 's'}`)
      .join(' y ');
    // 409 y no 422: no es que la peticion este mal formada, es que el
    // registro choca con lo que ya lo apunta. Es el mismo caso que
    // EMAIL_DUPLICADO o RFC_DUPLICADO.
    throw new Conflicto('EN_USO', `No se puede borrar "${actual.nombre}": la usan ${detalle}`, {
      usos,
    });
  }

  await db.query(`DELETE FROM ${def.tabla} WHERE id = $1`, [id]);
}
