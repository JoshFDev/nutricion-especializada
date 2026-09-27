import type { PoolClient } from 'pg';
import type { ListarExistencia } from './esquemas.js';
import type { Existencia, Listado } from './modelo.js';
import * as repo from './repositorio.js';

/**
 * Inventario: existir.
 *
 * El unico proposito de este modulo es que la compra se pueda VER. Una compra
 * entra 40 bultos de un producto y, sin una forma de leer la existencia, el
 * operador tiene que creer que entro porque el sistema lo dijo.
 *
 * Ajustar y mermar NO estan aqui. Necesitan motivo, se escriben en
 * `auditoria_inventario` y son la operacion que mas dano hace si se equivoca
 * alguien, asi que quedan fuera de este bloque a proposito.
 */
export async function listarExistencia(
  cliente: PoolClient,
  q: ListarExistencia,
): Promise<Listado<Existencia>> {
  return repo.listarExistencia(cliente, q);
}
