import type { PoolClient } from 'pg';
import { Conflicto, NoEncontrado } from '../../core/errores.js';
import { excelListaClientes } from './excel.js';
import * as repo from './repositorio.js';
import type { ActualizarCliente, CrearCliente, ListarClientes } from './esquemas.js';
import { mapeoCliente, mapeoNota, type Cliente, type ClienteConNotas } from './modelo.js';

/**
 * Capa de negocio: las reglas, sin saber nada de HTTP ni de SQL.
 *
 * Todo lo que aqui se decide se puede probar pasando un PoolClient falso,
 * sin levantar el servidor. Los controladores solo orquestan.
 */

export interface ListaPaginada<T> {
  datos: T[];
  paginacion: { limite: number; offset: number; total: number };
}

export async function listar(
  cliente: PoolClient,
  q: ListarClientes,
): Promise<ListaPaginada<Cliente>> {
  const { filas, total } = await repo.listar(cliente, q);
  return {
    datos: filas.map(mapeoCliente),
    paginacion: { limite: q.limite, offset: q.offset, total },
  };
}

export async function obtener(cliente: PoolClient, id: number): Promise<ClienteConNotas> {
  const fila = await repo.obtenerPorId(cliente, id);
  if (!fila) {
    throw new NoEncontrado(`No existe el cliente ${id}`);
  }

  const notas = await repo.listarNotas(cliente, id);

  return { ...mapeoCliente(fila), notas: notas.map(mapeoNota) };
}

export async function crear(cliente: PoolClient, datos: CrearCliente): Promise<Cliente> {
  // El UNIQUE de la base ya impide el duplicado y el traductor de
  // errores devuelve 409. Esto solo es para dar un mensaje claro.
  if (await repo.existeCodigo(cliente, datos.codigo_cliente)) {
    throw new Conflicto(
      'CODIGO_DUPLICADO',
      `Ya existe un cliente con el codigo ${datos.codigo_cliente}`,
    );
  }
  return mapeoCliente(await repo.crear(cliente, datos));
}

export async function actualizar(
  cliente: PoolClient,
  id: number,
  datos: ActualizarCliente,
): Promise<Cliente> {
  if (datos.codigo_cliente && (await repo.existeCodigo(cliente, datos.codigo_cliente, id))) {
    throw new Conflicto(
      'CODIGO_DUPLICADO',
      `Otro cliente ya usa el codigo ${datos.codigo_cliente}`,
    );
  }

  const fila = await repo.actualizar(cliente, id, datos);
  if (!fila) {
    throw new NoEncontrado(`No existe el cliente ${id}`);
  }
  return mapeoCliente(fila);
}

export async function eliminar(cliente: PoolClient, id: number): Promise<void> {
  if (!(await repo.eliminar(cliente, id))) {
    throw new NoEncontrado(`No existe el cliente ${id}`);
  }
}

/**
 * El Excel del listado.
 *
 * Toma los mismos filtros que la lista y los pasa enteros: lo que se
 * exporta es lo que hay filtrado, no la página que se está viendo. Por eso
 * va por `listarTodos` y no por `listar`, que además hace el COUNT que aquí
 * no se usa.
 */
export async function exportarExcel(cliente: PoolClient, q: ListarClientes): Promise<Buffer> {
  const filas = await repo.listarTodos(cliente, q);
  return excelListaClientes(filas.map(mapeoCliente));
}
