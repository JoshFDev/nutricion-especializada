import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import type { CrearCompra, ListarCompras } from './esquemas.js';
import type {
  CompraListada,
  EstatusCompra,
  FilaCompra,
  FilaRenglonCompra,
  Listado,
} from './modelo.js';

/**
 * SQL de compras.
 *
 * Lo que la base ya hace y aqui no se reimplementa: la entrada de inventario
 * por renglon (`fn_sincronizar_inventario_compra`), el recalculo de
 * `monto_total`, el kg por bulto por omision, el saldo del proveedor y la
 * reversa de inventario al cancelar
 * (`fn_revertir_inventario_por_cancelacion_compra`).
 */

const COLUMNAS_COMPRA = `
  c.id, c.proveedor_id, c.fecha, c.folio_proveedor, c.monto_total,
  c.estatus, c.motivo_cancelacion, c.creado_en,
  p.nombre AS proveedor_nombre
`;

const FROM_COMPRA = `
  FROM compras c
  JOIN proveedores p ON p.id = c.proveedor_id
`;

const COLUMNAS_RENGLON = `
  d.id, d.compra_id, d.producto_id, d.almacen_id,
  d.cantidad_bultos, d.kg_bulto, d.precio_kg, d.subtotal,
  pr.codigo AS producto_codigo, pr.nombre AS producto_nombre,
  a.nombre  AS almacen_nombre
`;

const FROM_RENGLON = `
  FROM compra_detalle d
  JOIN productos pr ON pr.id = d.producto_id
  JOIN almacenes  a  ON a.id = d.almacen_id
`;

export async function proveedorExiste(
  cliente: PoolClient,
  id: number,
): Promise<{ existe: boolean; activo: boolean }> {
  const f = await consultarUno<{ activo: boolean }>(
    cliente,
    `SELECT activo FROM proveedores WHERE id = $1`,
    [id],
  );
  if (!f) return { existe: false, activo: false };
  return { existe: true, activo: f.activo };
}

export async function almacenExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const f = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM almacenes WHERE id = $1`,
    [id],
  );
  return f !== null;
}

/** El producto con lo que hace falta para el renglon: si esta activo y su empaque. */
export async function producto(
  cliente: PoolClient,
  id: number,
): Promise<{ activo: boolean; presentacion_kg: string } | null> {
  const f = await consultarUno<{ activo: boolean; presentacion_kg: string }>(
    cliente,
    `SELECT activo, presentacion_kg::TEXT AS presentacion_kg FROM productos WHERE id = $1`,
    [id],
  );
  return f ?? null;
}

/**
 * Ultimo costo vigente de un proveedor para un producto en una fecha.
 *
 * Misma forma que `resolverEfectivo` en el modulo de precios: se toma el
 * registro cuyo rango contiene a la fecha, el mas reciente de los que
 * sirvan. Es la FECHA DE LA COMPRA y no la de hoy, por el mismo motivo que en
 * notas: una compra del mes pasado con el costo de hoyfalsea el margen de
 * ese mes.
 */
export async function costoVigente(
  cliente: PoolClient,
  proveedorId: number,
  productoId: number,
  fecha: string,
): Promise<string | null> {
  const f = await consultarUno<{ precio_kg: string }>(
    cliente,
    `SELECT precio_kg::TEXT AS precio_kg
       FROM producto_proveedor_precios
      WHERE proveedor_id = $1
        AND producto_id = $2
        AND vigente_desde <= $3::date
        AND (vigente_hasta IS NULL OR vigente_hasta >= $3::date)
      ORDER BY vigente_desde DESC
      LIMIT 1`,
    [proveedorId, productoId, fecha],
  );
  return f?.precio_kg ?? null;
}

export async function insertarCabecera(
  cliente: PoolClient,
  d: CrearCompra & { fecha: string },
): Promise<number> {
  const f = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO compras (proveedor_id, fecha, folio_proveedor)
     VALUES ($1, $2::date, $3)
     RETURNING id`,
    [d.proveedor_id, d.fecha, d.folio_proveedor ?? null],
  );
  return Number(f?.id);
}

export async function insertarRenglon(
  cliente: PoolClient,
  d: {
    compra_id: number;
    producto_id: number;
    almacen_id: number;
    cantidad_bultos: string;
    kg_bulto: string | null;
    precio_kg: string;
  },
): Promise<void> {
  await cliente.query(
    `INSERT INTO compra_detalle (compra_id, producto_id, almacen_id, cantidad_bultos, kg_bulto, precio_kg)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [d.compra_id, d.producto_id, d.almacen_id, d.cantidad_bultos, d.kg_bulto, d.precio_kg],
  );
}

export async function consultarCompra(cliente: PoolClient, id: number): Promise<FilaCompra | null> {
  return consultarUno<FilaCompra>(
    cliente,
    `SELECT ${COLUMNAS_COMPRA} ${FROM_COMPRA} WHERE c.id = $1`,
    [id],
  );
}

export async function listarRenglones(
  cliente: PoolClient,
  compraId: number,
): Promise<FilaRenglonCompra[]> {
  return consultar<FilaRenglonCompra>(
    cliente,
    `SELECT ${COLUMNAS_RENGLON} ${FROM_RENGLON}
      WHERE d.compra_id = $1
      ORDER BY d.id`,
    [compraId],
  );
}

/**
 * Lo que falta por pagar de la compra, calculado en la base: `monto_total`
 * menos lo ya abonado en `pagos_proveedor`.
 *
 * Se usa como el monto del abono que deja la compra 'pagada': se paga
 * EXACTAMENTE lo que falta y ni un centavo mas, para que el saldo del
 * proveedor (que sale de restar la suma de pagos al total) no se pase de
 * ceros.
 */
export async function saldoRestante(
  cliente: PoolClient,
  id: number,
): Promise<{ restante: string } | null> {
  return consultarUno<{ restante: string }>(
    cliente,
    `SELECT (c.monto_total - COALESCE(
              (SELECT SUM(pp.monto) FROM pagos_proveedor pp WHERE pp.compra_id = c.id), 0
            ))::TEXT AS restante
       FROM compras c
      WHERE c.id = $1`,
    [id],
  );
}

/**
 * Registra el abono en `pagos_proveedor`.
 *
 * El resto lo hacen los triggers de 0001: `trg_saldo_proveedor_por_pago`
 * recalcula el saldo del proveedor y `trg_estatus_compra_por_pago` mueve el
 * estatus a 'pagada'/'parcial'. A diferencia del resto de las tablas, aqui no
 * hay trigger de permiso: el control del `compras.crear` lo pone la ruta.
 */
export async function insertarPago(
  cliente: PoolClient,
  d: { proveedor_id: number; compra_id: number; monto: string },
): Promise<void> {
  await cliente.query(
    `INSERT INTO pagos_proveedor (proveedor_id, compra_id, monto)
     VALUES ($1, $2, $3)`,
    [d.proveedor_id, d.compra_id, d.monto],
  );
}

/**
 * Cancela la compra.
 *
 * El `WHERE estatus <> 'cancelada'` hace la operacion idempotente sobre el
 * papel: si ya estaba cancelada no cambia nada y no hay renglones que
 * revertir dos veces. El servicio avisa antes con un 409.
 *
 * El estatus y el motivo van en el MISMO UPDATE a proposito: si fueran dos,
 * el trigger de reversa de inventario veria la compra todavia 'pendiente' y
 * no revertiria nada.
 */
export async function cancelar(cliente: PoolClient, id: number, motivo: string): Promise<boolean> {
  const r = await consultar<{ id: string }>(
    cliente,
    `UPDATE compras
        SET estatus = 'cancelada', motivo_cancelacion = $2
      WHERE id = $1 AND estatus <> 'cancelada'
      RETURNING id`,
    [id, motivo],
  );
  return r.length > 0;
}

const construirFiltro = (q: ListarCompras) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.proveedor_id !== undefined) {
    valores.push(q.proveedor_id);
    condiciones.push(`c.proveedor_id = $${valores.length}`);
  }

  if (q.estatus !== undefined) {
    valores.push(q.estatus);
    condiciones.push(`c.estatus = $${valores.length}`);
  }

  if (q.desde !== undefined) {
    valores.push(q.desde);
    condiciones.push(`c.fecha >= $${valores.length}::date`);
  }

  if (q.hasta !== undefined) {
    valores.push(q.hasta);
    condiciones.push(`c.fecha <= $${valores.length}::date`);
  }

  // El folio del proveedor y el nombre. El folio se busca con ILIKE porque
  // el operador lo teclea incompleto la mitad de las veces ("no se que
  // numero tiene" no es un motivo para no buscar).
  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(p.nombre ILIKE $${valores.length} OR c.folio_proveedor ILIKE $${valores.length})`,
    );
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '',
  };
};

export async function listar(
  cliente: PoolClient,
  q: ListarCompras,
): Promise<Listado<CompraListada>> {
  const { valores, donde } = construirFiltro(q);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total ${FROM_COMPRA} ${donde}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    proveedor_id: string;
    proveedor_nombre: string;
    fecha: string;
    folio_proveedor: string | null;
    monto_total: string;
    estatus: EstatusCompra;
    renglones: string;
  }>(
    cliente,
    `SELECT c.id, c.proveedor_id, c.fecha, c.folio_proveedor, c.monto_total, c.estatus,
            p.nombre AS proveedor_nombre,
            (SELECT count(*) FROM compra_detalle d WHERE d.compra_id = c.id)::TEXT AS renglones
       ${FROM_COMPRA}
       ${donde}
     ORDER BY c.fecha DESC, c.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      proveedor_id: Number(f.proveedor_id),
      proveedor: f.proveedor_nombre,
      fecha: fechaComoTexto(f.fecha),
      folio_proveedor: f.folio_proveedor,
      monto_total: Number(f.monto_total),
      estatus: f.estatus,
      renglones: Number(f.renglones),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}
