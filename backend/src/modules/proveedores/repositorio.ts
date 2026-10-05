import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import type { ActualizarProveedor, CrearProveedor, ListarProveedores } from './esquemas.js';
import type { FilaProveedor, Listado, ProveedorListado } from './modelo.js';

/** SQL de proveedores. La tabla es pequena y casi todo son escrituras. */

export async function existeNombre(
  cliente: PoolClient,
  nombre: string,
  exceptoId?: number,
): Promise<boolean> {
  const f = await consultarUno<{ ok: boolean }>(
    cliente,
    exceptoId === undefined
      ? `SELECT TRUE AS ok FROM proveedores WHERE nombre = $1`
      : `SELECT TRUE AS ok FROM proveedores WHERE nombre = $1 AND id <> $2`,
    exceptoId === undefined ? [nombre] : [nombre, exceptoId],
  );
  return f !== null;
}

export async function crear(cliente: PoolClient, d: CrearProveedor): Promise<FilaProveedor> {
  const f = await consultarUno<FilaProveedor>(
    cliente,
    `INSERT INTO proveedores (nombre, contacto, telefono)
     VALUES ($1, $2, $3)
     RETURNING id, nombre, contacto, telefono, saldo_actual, activo, creado_en,
               0::TEXT AS compras`,
    [d.nombre, d.contacto ?? null, d.telefono ?? null],
  );
  if (!f) throw new Error('El INSERT de proveedor no devolvio fila');
  return f;
}

/**
 * Actualizacion parcial.
 *
 * El objeto se arma campo por campo y no pasandolo tal cual: con
 * `exactOptionalPropertyTypes` mandar `contacto: undefined` NO es lo mismo
 * que no mandarlo, y el `if` de cada columna no lo distinguiria. Sin
 * este filtro, corregir el telefono borraria el nombre del contacto.
 */
export async function actualizar(
  cliente: PoolClient,
  id: number,
  d: ActualizarProveedor,
): Promise<FilaProveedor | null> {
  const valores: unknown[] = [];
  const asignaciones: string[] = [];

  if (d.nombre !== undefined) {
    valores.push(d.nombre);
    asignaciones.push(`nombre = $${valores.length}`);
  }
  if (d.contacto !== undefined) {
    valores.push(d.contacto);
    asignaciones.push(`contacto = $${valores.length}`);
  }
  if (d.telefono !== undefined) {
    valores.push(d.telefono);
    asignaciones.push(`telefono = $${valores.length}`);
  }
  if (d.activo !== undefined) {
    valores.push(d.activo);
    asignaciones.push(`activo = $${valores.length}`);
  }

  if (asignaciones.length === 0) return null;

  return consultarUno<FilaProveedor>(
    cliente,
    `UPDATE proveedores
        SET ${asignaciones.join(', ')}
      WHERE id = $${valores.length + 1}
      RETURNING id, nombre, contacto, telefono, saldo_actual, activo, creado_en,
                (SELECT count(*) FROM compras c WHERE c.proveedor_id = proveedores.id)::TEXT AS compras`,
    [...valores, id],
  );
}

export async function consultarProveedor(
  cliente: PoolClient,
  id: number,
): Promise<FilaProveedor | null> {
  return consultarUno<FilaProveedor>(
    cliente,
    `SELECT id, nombre, contacto, telefono, saldo_actual, activo, creado_en,
            (SELECT count(*) FROM compras c WHERE c.proveedor_id = proveedores.id)::TEXT AS compras
       FROM proveedores WHERE id = $1`,
    [id],
  );
}

const construirFiltro = (q: ListarProveedores) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.activo !== undefined) {
    valores.push(q.activo);
    condiciones.push(`activo = $${valores.length}`);
  }

  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(nombre ILIKE $${valores.length}
        OR contacto ILIKE $${valores.length}
        OR telefono ILIKE $${valores.length})`,
    );
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '',
  };
};

/**
 * Las columnas del listado, con el conteo de compras.
 *
 * Vive aqui y no en cada consulta porque `listar` y `listarTodos` la comparten
 * y tienen que verse IGUALES: si una de las dos se queda una columna, el
 * listado de la pantalla y el Excel teach cosas distintas sin que nada falle.
 */
const SELECT_LISTADO = `SELECT id, nombre, contacto, telefono, saldo_actual, activo, creado_en,
        (SELECT count(*) FROM compras c WHERE c.proveedor_id = proveedores.id)::TEXT AS compras
   FROM proveedores`;

/** La fila del listado: `saldo_actual` llega como texto de Postgres. */
const mapearListado = (f: FilaProveedor): ProveedorListado => ({
  id: Number(f.id),
  nombre: f.nombre,
  contacto: f.contacto,
  telefono: f.telefono,
  saldo_actual: Number(f.saldo_actual),
  activo: f.activo,
  compras: Number(f.compras),
});

/**
 * La MISMA consulta sin `LIMIT`, para el Excel.
 *
 * Comparte el filtro con `listar` a propósito: la exportación tiene que traer
 * lo que hay filtrado y no lo que cabe en la página de 50 que se está viendo.
 * El `COUNT` no se hace aquí porque solo lo necesita la barra de paginación.
 */
export async function listarTodos(
  cliente: PoolClient,
  q: ListarProveedores,
): Promise<ProveedorListado[]> {
  const { valores, donde } = construirFiltro(q);

  const filas = await consultar<FilaProveedor>(
    cliente,
    `${SELECT_LISTADO}
     ${donde}
     ORDER BY nombre`,
    valores,
  );

  return filas.map(mapearListado);
}

export async function listar(
  cliente: PoolClient,
  q: ListarProveedores,
): Promise<Listado<ProveedorListado>> {
  const { valores, donde } = construirFiltro(q);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total FROM proveedores ${donde}`,
    valores,
  );

  const filas = await consultar<FilaProveedor>(
    cliente,
    `${SELECT_LISTADO}
     ${donde}
     ORDER BY nombre
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map(mapearListado),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}
