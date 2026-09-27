import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import { componerFolio, type EstatusNota } from '../notas-remision/modelo.js';
import type { CrearPago, ListarPagos } from './esquemas.js';
import type { FilaAplicacion, FilaPago, Listado, NotaCobrable, PagoListado } from './modelo.js';

/**
 * SQL de pagos.
 *
 * Lo que la base ya resuelve y aqui NO se reimplementa: el estatus de la
 * nota segun lo aplicado (`fn_actualizar_estatus_por_aplicaciones`), el
 * saldo del cliente (`fn_recalcular_saldo_cliente`) y los topes de lo
 * aplicado a un pago y a una nota (`fn_validar_aplicacion_pago`).
 *
 * Lo que si se hace en el servicio, y tiene que hacerse ahi, son las tres
 * reglas que la base no puede saber: que la nota sea del mismo cliente, que
 * no este cancelada, y que el error le llegue al operador con un codigo
 * util en vez de un 23514.
 */

/**
 * El subquery de aplicaciones se usa en el detalle y en el listado, asi
 * que vive aqui una sola vez. Se agrega al LEFT JOIN porque un pago sin
 * aplicaciones (un abono a cuenta) es legitimo y no puede dejar fuera la
 * fila del listado.
 */
const SUBQUERY_APLICACIONES = `
  LEFT JOIN (
      SELECT pago_id,
             SUM(monto_aplicado) AS total,
             COUNT(*)            AS notas
        FROM pagos_aplicacion
       GROUP BY pago_id
  ) a ON a.pago_id = p.id
`;

const COLUMNAS_PAGO = `
  p.id, p.cliente_id, p.fecha, p.metodo, p.monto, p.requiere_factura,
  p.referencia, p.creado_en,
  c.nombre AS cliente_nombre,
  COALESCE(a.total, 0)::TEXT AS monto_aplicado
`;

const FROM_PAGO = `
  FROM pagos p
  JOIN clientes c ON c.id = p.cliente_id
  ${SUBQUERY_APLICACIONES}
`;

/** Para `total`: sin el subquery de aplicaciones, porque contar no lo necesita. */
const FROM_PAGO_SIN_APLICACIONES = `
  FROM pagos p
  JOIN clientes c ON c.id = p.cliente_id
`;

export async function clienteExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const fila = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM clientes WHERE id = $1`,
    [id],
  );
  return fila !== null;
}

/**
 * Candado sobre la nota, hasta el COMMIT.
 *
 * Es la misma carrera que se evita en notas con `pg_advisory_xact_lock`,
 * pero aqui contra la fila y no con un advisory: dos personas cobrando a
 * la vez el mismo abono es el caso normal de una caja, y lo que se quiere
 * serializar es esa nota en concreto.
 *
 * Sin esto, dos peticiones que aplican 500 a una nota de 1000 las dos
 * pasan la validacion: el trigger `trg_validar_aplicacion_pago` compara
 * contra la suma del momento, y entre una lectura y el INSERT cabe la
 * otra peticion. La nota queda con 1000 cobrados de un pago de 500, y el
 * estatus dice 'pagada' porque el trigger de estatus solo mira la suma.
 */
export async function candearNota(cliente: PoolClient, id: number): Promise<void> {
  await cliente.query('SELECT id FROM notas_remision WHERE id = $1 FOR UPDATE', [id]);
}

/** La nota con lo que hace falta para decidir si se le puede aplicar un pago. */
export async function notaParaPago(cliente: PoolClient, id: number): Promise<NotaCobrable | null> {
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

/** Cuanto de esa nota ya esta cobrado por otros pagos. */
export async function montoAplicadoEnNota(cliente: PoolClient, notaId: number): Promise<number> {
  const fila = await consultarUno<{ total: string }>(
    cliente,
    `SELECT COALESCE(SUM(monto_aplicado), 0)::TEXT AS total
       FROM pagos_aplicacion WHERE nota_id = $1`,
    [notaId],
  );
  return Number(fila?.total ?? 0);
}

export async function insertarPago(
  cliente: PoolClient,
  d: CrearPago & { fecha: string },
): Promise<number> {
  const f = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO pagos (cliente_id, fecha, metodo, monto, requiere_factura, referencia)
     VALUES ($1, $2::date, $3, $4, $5, $6)
     RETURNING id`,
    [d.cliente_id, d.fecha, d.metodo ?? null, d.monto, d.requiere_factura, d.referencia ?? null],
  );
  return Number(f?.id);
}

export async function insertarAplicacion(
  cliente: PoolClient,
  pagoId: number,
  notaId: number,
  monto: string,
): Promise<void> {
  await cliente.query(
    `INSERT INTO pagos_aplicacion (pago_id, nota_id, monto_aplicado)
     VALUES ($1, $2, $3)`,
    [pagoId, notaId, monto],
  );
}

export async function consultarPago(cliente: PoolClient, id: number): Promise<FilaPago | null> {
  return consultarUno<FilaPago>(cliente, `SELECT ${COLUMNAS_PAGO} ${FROM_PAGO} WHERE p.id = $1`, [
    id,
  ]);
}

export async function listarAplicaciones(
  cliente: PoolClient,
  pagoId: number,
): Promise<FilaAplicacion[]> {
  return consultar<FilaAplicacion>(
    cliente,
    `SELECT a.id, a.pago_id, a.nota_id, a.monto_aplicado,
            n.subtotal AS nota_subtotal, n.estatus AS nota_estatus,
            f.serie AS nota_serie, f.folio_numero AS nota_folio_numero
       FROM pagos_aplicacion a
       JOIN notas_remision n ON n.id = a.nota_id
       JOIN folios f         ON f.id = n.folio_id
      WHERE a.pago_id = $1
      ORDER BY a.id`,
    [pagoId],
  );
}

const construirFiltro = (q: ListarPagos) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.cliente_id !== undefined) {
    valores.push(q.cliente_id);
    condiciones.push(`p.cliente_id = $${valores.length}`);
  }

  if (q.metodo !== undefined) {
    valores.push(q.metodo);
    condiciones.push(`p.metodo = $${valores.length}`);
  }

  if (q.desde !== undefined) {
    valores.push(q.desde);
    condiciones.push(`p.fecha >= $${valores.length}::date`);
  }

  if (q.hasta !== undefined) {
    valores.push(q.hasta);
    condiciones.push(`p.fecha <= $${valores.length}::date`);
  }

  // Por nota: es la vista de "que pagos cobraron esta nota", que es como se
  // revisa un cobro que el cliente discute. Es un EXISTS y no un JOIN para
  // no duplicar pagos que tocan varias notas (cosa normal: un pago de 3000
  // que cubre tres notas aparece una vez, no tres).
  if (q.nota_id !== undefined) {
    valores.push(q.nota_id);
    condiciones.push(
      `EXISTS (SELECT 1 FROM pagos_aplicacion x
                WHERE x.pago_id = p.id AND x.nota_id = $${valores.length})`,
    );
  }

  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(c.nombre ILIKE $${valores.length} OR p.referencia ILIKE $${valores.length})`,
    );
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '',
  };
};

export async function listar(cliente: PoolClient, q: ListarPagos): Promise<Listado<PagoListado>> {
  const { valores, donde } = construirFiltro(q);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total ${FROM_PAGO_SIN_APLICACIONES} ${donde}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    cliente_id: string;
    cliente_nombre: string;
    fecha: string;
    metodo: PagoListado['metodo'];
    monto: string;
    monto_aplicado: string;
    requiere_factura: boolean;
    referencia: string | null;
    notas: string;
  }>(
    cliente,
    `SELECT p.id, p.cliente_id, p.fecha, p.metodo, p.monto, p.requiere_factura,
            p.referencia,
            c.nombre AS cliente_nombre,
            COALESCE(a.total, 0)::TEXT AS monto_aplicado,
            COALESCE(a.notas, 0)::TEXT AS notas
       ${FROM_PAGO}
       ${donde}
     ORDER BY p.fecha DESC, p.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      cliente_id: Number(f.cliente_id),
      cliente: f.cliente_nombre,
      fecha: fechaComoTexto(f.fecha),
      metodo: f.metodo,
      monto: Number(f.monto),
      monto_aplicado: Number(f.monto_aplicado),
      saldo: Number((Number(f.monto) - Number(f.monto_aplicado)).toFixed(2)),
      requiere_factura: f.requiere_factura,
      referencia: f.referencia,
      notas: Number(f.notas),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}
