import type { PoolClient } from 'pg';
import { contar, consultar } from '../../db/transaccion.js';
import type { ListarExistencia } from './esquemas.js';
import type { Existencia, Listado } from './modelo.js';

/**
 * SQL de inventario.
 *
 * No hay tabla de existencias: la existencia es la SUMA de los movimientos,
 * igual que hace `fn_existencia_de` (0001). Se lee de ahi y no de una tabla
 * derivada porque cualquier tabla de saldos tiene que actualizarse en cada
 * movimiento, y ese es un trigger mas que puede desfasarse.
 */

/**
 * El CROSS JOIN de productos por almacenes es lo que hace que un producto
 * sin movimientos aparezca con 0 y no desaparezca del reporte: un producto
 * que nunca se compro no esta "sin stock", esta en cero, y hay que verlo.
 * Es la misma cuenta que hace la vista `vw_existencia_actual` de 0001.
 */
const DESDE_MOVIMIENTOS = `
  FROM productos pr
  CROSS JOIN almacenes a
  LEFT JOIN (
      SELECT producto_id, almacen_id,
             SUM(CASE WHEN tipo IN ('entrada_compra','ajuste_positivo')
                      THEN cantidad_bultos ELSE -cantidad_bultos END) AS e
        FROM inventario_movimientos
       GROUP BY producto_id, almacen_id
  ) m ON m.producto_id = pr.id AND m.almacen_id = a.id
`;

const construirWhere = (q: ListarExistencia) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  // Por omision salen TODAS las combinaciones, en cero incluidas. Con
  // `vacios=true` se invierte: solo las que estan en cero o en negativo, que
  // es la pantalla de "que se esta acabando".
  if (q.vacios !== undefined) {
    condiciones.push(q.vacios ? `COALESCE(m.e, 0) <= 0` : `COALESCE(m.e, 0) > 0`);
  }

  if (q.producto_id !== undefined) {
    valores.push(q.producto_id);
    condiciones.push(`pr.id = $${valores.length}`);
  }

  if (q.almacen_id !== undefined) {
    valores.push(q.almacen_id);
    condiciones.push(`a.id = $${valores.length}`);
  }

  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(`(pr.codigo ILIKE $${valores.length} OR pr.nombre ILIKE $${valores.length})`);
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '',
  };
};

export async function listarExistencia(
  cliente: PoolClient,
  q: ListarExistencia,
): Promise<Listado<Existencia>> {
  const { valores, donde } = construirWhere(q);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total ${DESDE_MOVIMIENTOS} ${donde}`,
    valores,
  );

  const filas = await consultar<{
    producto_id: string;
    producto_codigo: string;
    producto_nombre: string;
    almacen_id: number;
    almacen_nombre: string;
    existencia_bultos: string;
    producto_activo: boolean;
  }>(
    cliente,
    `SELECT pr.id AS producto_id, pr.codigo AS producto_codigo, pr.nombre AS producto_nombre,
            a.id AS almacen_id, a.nombre AS almacen_nombre,
            COALESCE(m.e, 0)::TEXT AS existencia_bultos,
            pr.activo AS producto_activo
       ${DESDE_MOVIMIENTOS}
       ${donde}
     ORDER BY pr.nombre, a.nombre
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map((f) => ({
      producto_id: Number(f.producto_id),
      producto_codigo: f.producto_codigo,
      producto: f.producto_nombre,
      almacen_id: f.almacen_id,
      almacen: f.almacen_nombre,
      existencia_bultos: Number(f.existencia_bultos),
      producto_activo: f.producto_activo,
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}
