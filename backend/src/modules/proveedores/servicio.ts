import type { PoolClient } from 'pg';
import { Conflicto, NoEncontrado } from '../../core/errores.js';
import { excelListaProveedores } from './excel.js';
import type { ActualizarProveedor, CrearProveedor, ListarProveedores } from './esquemas.js';
import type { Listado, Proveedor, ProveedorListado } from './modelo.js';
import { mapearProveedor } from './modelo.js';
import * as repo from './repositorio.js';

/**
 * Proveedores.
 *
 * Es el modulo mas pequeno del proyecto y casi todo lo que hace es dejar
 * escribir el nombre de quien vendio el producto. Sin el, `compras` no
 * tiene a quien perguntarle: `compras.proveedor_id` es FK dura.
 *
 * `saldo_actual` no se toca nunca desde aqui. Lo recalcula
 * `fn_recalcular_saldo_proveedor` con las compras y los pagos al proveedor.
 */
export async function listar(
  cliente: PoolClient,
  q: ListarProveedores,
): Promise<Listado<ProveedorListado>> {
  return repo.listar(cliente, q);
}

export async function consultar(cliente: PoolClient, id: number): Promise<Proveedor> {
  const fila = await repo.consultarProveedor(cliente, id);
  if (!fila) throw new NoEncontrado(`No existe el proveedor ${id}`);
  return mapearProveedor(fila);
}

export async function crear(cliente: PoolClient, d: CrearProveedor): Promise<Proveedor> {
  // El UNIQUE de la base ya lo impide; esto es para el mensaje.
  if (await repo.existeNombre(cliente, d.nombre)) {
    throw new Conflicto(
      'PROVEEDOR_DUPLICADO',
      `Ya existe un proveedor con el nombre "${d.nombre}"`,
    );
  }
  return mapearProveedor(await repo.crear(cliente, d));
}

export async function actualizar(
  cliente: PoolClient,
  id: number,
  d: ActualizarProveedor,
): Promise<Proveedor> {
  if (d.nombre !== undefined && (await repo.existeNombre(cliente, d.nombre, id))) {
    throw new Conflicto('PROVEEDOR_DUPLICADO', `Otro proveedor ya usa el nombre "${d.nombre}"`);
  }
  const fila = await repo.actualizar(cliente, id, d);
  if (!fila) throw new NoEncontrado(`No existe el proveedor ${id}`);
  return mapearProveedor(fila);
}

/**
 * El Excel del listado.
 *
 * El filtro es el mismo que el de la pantalla y entra COMPLETO: lo que se
 * exporta es lo que hay filtrado, no la página que se está viendo. Por eso
 * va por `listarTodos`, que no trae el `COUNT` que aquí no hace falta.
 */
export async function exportarExcel(cliente: PoolClient, q: ListarProveedores): Promise<Buffer> {
  return excelListaProveedores(await repo.listarTodos(cliente, q));
}
