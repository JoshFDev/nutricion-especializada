import type { PoolClient } from 'pg';
import { consultar, consultarUno, contar } from '../../db/transaccion.js';
import type { CrearMovimiento, ListarExistencia, ListarMovimientos } from './esquemas.js';
import type { Existencia, FilaMovimiento, Listado, Movimiento } from './modelo.js';

/**
 * SQL de inventario.
 *
 * No hay tabla de existencias: la existencia es la SUMA de los movimientos,
 * igual que hace `fn_existencia_de` (0001). Se lee de ahi y no de una tabla
 * derivada porque cualquier tabla de saldos tiene que actualizarse en cada
 * movimiento, y ese es un trigger mas que puede desfasarse.
 *
 * Escribir un movimiento manual (ajuste o merma) es UN insert: el antes y el
 * despues de `auditoria_inventario`, la alerta de stock negativo y la "foto"
 * semanal los escriben los triggers de 0001 por su cuenta. No hay nada que
 * reimplementar aqui, igual que caja no reimplementa su saldo.
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

// ------------------------------------------------------------- el kardex

/**
 * El kardex de un producto en un almacen.
 *
 * Trae TAMBIEN los movimientos de compra y venta (con su `referencia_tabla`
 * llena), porque es la historia del producto: el operador ve de donde salio
 * cada bulto. Lo que no puede es BORRARLOS: solo los manuales se borran, y
 * por eso el mapeo expone `manual` y el DELETE lo comprueba en el servicio.
 */
const COLUMNAS_MOVIMIENTO = `
  m.id, m.producto_id, m.almacen_id, m.fecha, m.tipo, m.cantidad_bultos,
  m.motivo, m.referencia_tabla, m.creado_en,
  pr.nombre AS producto, pr.codigo AS producto_codigo,
  a.nombre AS almacen
`;

const DESDE_MOVIMIENTO = `
  FROM inventario_movimientos m
  JOIN productos pr ON pr.id = m.producto_id
  JOIN almacenes a ON a.id = m.almacen_id
`;

const construirFiltroMovimiento = (q: ListarMovimientos) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.producto_id !== undefined) {
    valores.push(q.producto_id);
    condiciones.push(`m.producto_id = $${valores.length}`);
  }
  if (q.almacen_id !== undefined) {
    valores.push(q.almacen_id);
    condiciones.push(`m.almacen_id = $${valores.length}`);
  }
  if (q.tipo !== undefined) {
    valores.push(q.tipo);
    condiciones.push(`m.tipo = $${valores.length}`);
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '',
  };
};

export async function listarMovimientos(
  cliente: PoolClient,
  q: ListarMovimientos,
): Promise<Listado<Movimiento>> {
  const { valores, donde } = construirFiltroMovimiento(q);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total ${DESDE_MOVIMIENTO} ${donde}`,
    valores,
  );

  const filas = await consultar<FilaMovimiento>(
    cliente,
    `SELECT ${COLUMNAS_MOVIMIENTO} ${DESDE_MOVIMIENTO}
     ${donde}
     ORDER BY m.fecha DESC, m.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map(mapearMovimiento),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

export async function consultarMovimiento(
  cliente: PoolClient,
  id: number,
): Promise<FilaMovimiento | null> {
  return consultarUno<FilaMovimiento>(
    cliente,
    `SELECT ${COLUMNAS_MOVIMIENTO} ${DESDE_MOVIMIENTO} WHERE m.id = $1`,
    [id],
  );
}

export async function productoExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const f = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM productos WHERE id = $1`,
    [id],
  );
  return f !== null;
}

export async function almacenExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const f = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM almacenes WHERE id = $1`,
    [id],
  );
  return f !== null;
}

export async function crearMovimiento(cliente: PoolClient, d: CrearMovimiento): Promise<number> {
  const f = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO inventario_movimientos
        (producto_id, almacen_id, tipo, cantidad_bultos, motivo)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [d.producto_id, d.almacen_id, d.tipo, d.cantidad_bultos, d.motivo],
  );
  if (!f) throw new Error('El INSERT de movimiento no devolvio fila');
  return Number(f.id);
}

/**
 * Borra SOLO los manuales.
 *
 * El `AND referencia_tabla IS NULL` es doble candado con el servicio: aunque
 * alguien llame al repositorio con un id de compra, la base no lo borra. El
 * trigger `trg_permiso_inventario` exige `inventario.ajustar` y registra el
 * antes y el despues en `auditoria_inventario`; el stock vuelve solo.
 */
export async function borrarMovimientoManual(cliente: PoolClient, id: number): Promise<boolean> {
  const r = await cliente.query(
    `DELETE FROM inventario_movimientos
      WHERE id = $1 AND referencia_tabla IS NULL`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

export const mapearMovimiento = (f: FilaMovimiento): Movimiento => ({
  id: Number(f.id),
  producto_id: Number(f.producto_id),
  producto_codigo: f.producto_codigo,
  producto: f.producto,
  almacen_id: f.almacen_id,
  almacen: f.almacen,
  fecha: fechaIso(f.fecha),
  tipo: f.tipo,
  cantidad_bultos: Number(f.cantidad_bultos),
  motivo: f.motivo,
  manual: f.referencia_tabla === null,
  creado_en: fechaIso(f.creado_en),
});

/** TIMESTAMP de la base a ISO local; un kardex se lee con la hora. */
const fechaIso = (valor: Date | string): string => {
  if (typeof valor === 'string') return valor;
  const r = new Date(valor);
  return Number.isNaN(r.getTime())
    ? String(valor)
    : `${String(r.getFullYear()).padStart(4, '0')}-${String(r.getMonth() + 1).padStart(2, '0')}-${String(r.getDate()).padStart(2, '0')}T${String(r.getHours()).padStart(2, '0')}:${String(r.getMinutes()).padStart(2, '0')}`;
};
