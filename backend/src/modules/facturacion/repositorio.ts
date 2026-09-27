import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import { componerFolio, type EstatusNota } from '../notas-remision/modelo.js';
import type { CrearFactura, ListarFacturas } from './esquemas.js';
import type {
  EstatusFactura,
  FilaFactura,
  Listado,
  FacturaListada,
  NotaFacturada,
} from './modelo.js';

/**
 * SQL de facturacion.
 *
 * Lo que la base ya resuelve y aqui NO se reimplementa: los permisos
 * (`trg_permiso_facturas` y `trg_permiso_factura_nota`, migracion 0010) y la
 * bitacora (`trg_facturas_auditoria`, tambien 0010).
 *
 * Lo que si se hace en el servicio son las tres cosas que la base no puede
 * saber, y que estan en `servicio.ts`.
 */

/** La nota con lo que hace falta para decidir si se puede facturar. */
export interface NotaFacturable {
  id: number;
  cliente_id: number;
  subtotal: number;
  estatus: EstatusNota;
  folio: string;
}

export const COLUMNAS_FACTURA = `
  f.id, f.cliente_id, f.fecha, f.metodo_pago, f.monto_total, f.estatus,
  f.motivo_cancelacion, f.creado_en,
  c.nombre AS cliente_nombre
`;

export const DESDE_FACTURA = `
  FROM facturas f
  JOIN clientes c ON c.id = f.cliente_id
`;

/**
 * `total` y las filas usan el MISMO `FROM`, y no es descuido: `buscar` filtra
 * por `c.nombre`, y contar con un `FROM` mas pobre que el de las filas deja la
 * columna fuera del alcance. El JOIN con `clientes` es 1:1, asi que contar
 * sobre el `FROM` completo no multiplica filas ni falsea el total.
 */

export async function clienteExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const f = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM clientes WHERE id = $1`,
    [id],
  );
  return f !== null;
}

export async function notaParaFactura(
  cliente: PoolClient,
  id: number,
): Promise<NotaFacturable | null> {
  const f = await consultarUno<{
    id: string;
    cliente_id: string;
    subtotal: string;
    estatus: EstatusNota;
    serie: string;
    folio_numero: number;
  }>(
    cliente,
    `SELECT n.id, n.cliente_id, n.subtotal, n.estatus, f.serie, f.folio_numero
       FROM notas_remision n
       JOIN folios f ON f.id = n.folio_id
      WHERE n.id = $1`,
    [id],
  );
  if (!f) return null;
  return {
    id: Number(f.id),
    cliente_id: Number(f.cliente_id),
    subtotal: Number(f.subtotal),
    estatus: f.estatus,
    folio: componerFolio(f.serie, f.folio_numero),
  };
}

/**
 * Que factura activa, si hay alguna, ya cubre esta nota.
 *
 * Solo mira facturas NO canceladas: una factura cancelada libera sus notas, y
 * volver a facturarlas tiene que ser posible (es el caso normal de "se
 * emitio mal el CFDI, se cancela y se vuelve a pedir"). La subconsulta es un
 * EXISTS y no un JOIN para no duplicar la fila de la nota.
 */
export async function facturaActivaDeNota(
  cliente: PoolClient,
  notaId: number,
): Promise<{ id: number; estatus: EstatusFactura } | null> {
  const f = await consultarUno<{ id: string; estatus: EstatusFactura }>(
    cliente,
    `SELECT f.id, f.estatus
       FROM facturas f
       JOIN factura_nota fn ON fn.factura_id = f.id
      WHERE fn.nota_id = $1
        AND f.estatus <> 'cancelada'
      ORDER BY f.id
      LIMIT 1`,
    [notaId],
  );
  return f === null ? null : { id: Number(f.id), estatus: f.estatus };
}

export async function insertarFactura(
  cliente: PoolClient,
  d: CrearFactura & { fecha: string; monto_total: string },
): Promise<number> {
  const f = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO facturas (cliente_id, fecha, metodo_pago, monto_total, estatus)
     VALUES ($1, $2::date, $3, $4, 'solicitada')
     RETURNING id`,
    [d.cliente_id, d.fecha, d.metodo_pago ?? null, d.monto_total],
  );
  return Number(f?.id);
}

export async function insertarNota(cliente: PoolClient, facturaId: number, notaId: number) {
  await cliente.query(`INSERT INTO factura_nota (factura_id, nota_id) VALUES ($1, $2)`, [
    facturaId,
    notaId,
  ]);
}

export async function consultarFactura(
  cliente: PoolClient,
  id: number,
): Promise<FilaFactura | null> {
  return consultarUno<FilaFactura>(
    cliente,
    `SELECT ${COLUMNAS_FACTURA} ${DESDE_FACTURA} WHERE f.id = $1`,
    [id],
  );
}

export async function actualizarEstatus(
  cliente: PoolClient,
  id: number,
  estatus: EstatusFactura,
  motivo: string | null,
): Promise<number | null> {
  const f = await consultarUno<{ id: string }>(
    cliente,
    `UPDATE facturas
        SET estatus = $2,
            motivo_cancelacion = CASE WHEN $2 = 'cancelada' THEN $3 ELSE NULL END
      WHERE id = $1
      RETURNING id`,
    [id, estatus, motivo],
  );
  return f === null ? null : Number(f.id);
}

export async function listarNotas(
  cliente: PoolClient,
  facturaId: number,
): Promise<NotaFacturada[]> {
  const filas = await consultar<{
    nota_id: string;
    serie: string;
    folio_numero: number;
    fecha: Date | string;
    subtotal: string;
    estatus: EstatusNota;
  }>(
    cliente,
    `SELECT n.id AS nota_id, n.fecha, n.subtotal, n.estatus, f.serie, f.folio_numero
       FROM factura_nota fn
       JOIN notas_remision n ON n.id = fn.nota_id
       JOIN folios f         ON f.id = n.folio_id
      WHERE fn.factura_id = $1
      ORDER BY n.fecha, n.id`,
    [facturaId],
  );
  return filas.map((f) => ({
    nota_id: Number(f.nota_id),
    nota: componerFolio(f.serie, f.folio_numero),
    fecha: fechaComoTexto(f.fecha),
    subtotal: Number(f.subtotal),
    estatus: f.estatus,
  }));
}

const construirFiltro = (q: ListarFacturas) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.cliente_id !== undefined) {
    valores.push(q.cliente_id);
    condiciones.push(`f.cliente_id = $${valores.length}`);
  }
  if (q.estatus !== undefined) {
    valores.push(q.estatus);
    condiciones.push(`f.estatus = $${valores.length}`);
  }
  if (q.desde !== undefined) {
    valores.push(q.desde);
    condiciones.push(`f.fecha >= $${valores.length}::date`);
  }
  if (q.hasta !== undefined) {
    valores.push(q.hasta);
    condiciones.push(`f.fecha <= $${valores.length}::date`);
  }
  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(c.nombre ILIKE $${valores.length} OR f.metodo_pago ILIKE $${valores.length})`,
    );
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '',
  };
};

export async function listar(
  cliente: PoolClient,
  q: ListarFacturas,
): Promise<Listado<FacturaListada>> {
  const { valores, donde } = construirFiltro(q);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total ${DESDE_FACTURA} ${donde}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    cliente_id: string;
    cliente_nombre: string;
    fecha: Date | string;
    metodo_pago: string | null;
    monto_total: string;
    estatus: EstatusFactura;
    notas: string;
  }>(
    cliente,
    `SELECT f.id, f.cliente_id, f.fecha, f.metodo_pago, f.monto_total, f.estatus,
            c.nombre AS cliente_nombre,
            (SELECT count(*) FROM factura_nota fn WHERE fn.factura_id = f.id)::TEXT AS notas
       ${DESDE_FACTURA}
       ${donde}
     ORDER BY f.fecha DESC, f.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      cliente_id: Number(f.cliente_id),
      cliente: f.cliente_nombre,
      fecha: fechaComoTexto(f.fecha),
      metodo_pago: f.metodo_pago,
      monto_total: Number(f.monto_total),
      estatus: f.estatus,
      notas: Number(f.notas),
      // Un campo derivado del estatus, para que el frontend no tenga que
      // comparar strings para pintar de rojo una factura cancelada.
      cancelada: f.estatus === 'cancelada',
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}
