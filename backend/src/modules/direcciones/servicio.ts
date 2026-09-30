import type { PoolClient } from 'pg';
import { Conflicto, NoEncontrado } from '../../core/errores.js';
import type { FilaDireccion } from './modelo.js';
import * as repo from './repositorio.js';

/**
 * Reglas del catalogo de direcciones de entrega.
 *
 * Es un catalogo, asi que casi todo lo que hay aqui es traducir el 23505 de
 * Postgres a un 409 que se entienda y comprobar que lo que se va a borrar
 * existe. Lo unico que decide el negocio es esto:
 *
 * **Guardar una direccion no la "crea en la nota"**. La nota se guarda con el
 * texto que hay escrito en el campo, y la direccion del catalogo es solo una
 * lista de textos ya escritos. Por eso una direccion se puede borrar sin
 * ningun aviso previo: ninguna nota la apunta (la nota copio el texto, ver
 * la migracion 0011), y borrar un destino que ya no se usa no cambia ningun
 * documento.
 */

/** Traduce el 23505 de `ux_direcciones_entrega_nombre_ci` a un 409 legible. */
const esNombreDuplicado = (error: unknown): boolean =>
  (error as { code?: string })?.code === '23505';

const nombreDuplicado = (nombre: string): Conflicto =>
  new Conflicto('NOMBRE_DUPLICADO', `Ya hay una direccion guardada con el nombre "${nombre}"`, {
    nombre,
  });

/** Como el catalogo de especies: la misma envoltura que ya usan las pantallas. */
export async function listar(db: PoolClient): Promise<{ datos: FilaDireccion[]; total: number }> {
  const filas = await repo.listar(db);
  return { datos: filas, total: filas.length };
}

export async function crear(db: PoolClient, d: { nombre: string; direccion: string }) {
  try {
    return await repo.crear(db, d);
  } catch (error) {
    if (esNombreDuplicado(error)) throw nombreDuplicado(d.nombre);
    throw error;
  }
}

export async function actualizar(
  db: PoolClient,
  id: number,
  d: { nombre: string; direccion: string },
): Promise<FilaDireccion> {
  const antes = await repo.obtener(db, id);
  if (!antes) throw new NoEncontrado('Esa direccion no existe');

  try {
    const ok = await repo.actualizar(db, id, d);
    if (!ok) throw new NoEncontrado('Esa direccion no existe');
  } catch (error) {
    if (esNombreDuplicado(error)) throw nombreDuplicado(d.nombre);
    throw error;
  }

  // Se relee en vez de inventar el resultado: el UPDATE devuelve el id y no
  // los textos, y devolver el `antes` con los valores nuevos encima
  // adivinaria el recorte que hizo el `trim` del esquema.
  const despues = await repo.obtener(db, id);
  if (!despues) throw new NoEncontrado('Esa direccion no existe');
  return despues;
}

/**
 * Borrar.
 *
 * No hay `contarUsos` ni "esta en uso" porque no hay FK que lo impida: la
 * nota guardo el texto. Aun asi se comprueba que exista ANTES de borrar, para
 * que un id equivocado de un formulario de hace dos dias diga "esa direccion no
 * existe" y no responda 204 como si hubiera borrado algo.
 */
export async function borrar(db: PoolClient, id: number): Promise<void> {
  if (!(await repo.borrar(db, id))) {
    throw new NoEncontrado('Esa direccion no existe');
  }
}
