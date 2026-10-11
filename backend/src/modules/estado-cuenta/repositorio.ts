import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import type { ListarEstadoCuenta } from './esquemas.js';
import type { Listado, RenglonEstadoCuenta } from './modelo.js';

/**
 * SQL del estado de cuenta.
 *
 * El listado lee la vista `vw_estado_cuenta_cliente` de 0001, igual que el
 * reporte del mismo nombre: es la misma pregunta y la vista ya trae el saldo
 * y las dos fechas. Los movimientos de la hoja salen de las dos tablas que
 * mueven la cuenta del cliente: `notas_remision` (la venta, la deuda) y
 * `pagos` (el abono).
 */

/** Junta las condiciones, o la cadena vacia si no hay ninguna. */
const donde = (condiciones: string[]): string =>
  condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '';

/** El `LIMIT`/`OFFSET` va al final, con los `$` que siguen al ultimo filtro. */
const pagina = (valores: unknown[]): string =>
  `LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`;

const paginacion = (valores: unknown[], q: { limite: number; offset: number }) => [
  ...valores,
  q.limite,
  q.offset,
];

/** El listado de clientes con su saldo, filtrado por nombre y por saldo. */
export async function listarClientes(
  cliente: PoolClient,
  q: ListarEstadoCuenta,
): Promise<Listado<RenglonEstadoCuenta>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(`cliente ILIKE $${valores.length}`);
  }
  if (q.solo_con_saldo) {
    // Los que deben (o tienen saldo a favor), no los que ya estan en cero.
    condiciones.push('saldo_actual <> 0');
  }

  const filtro = donde(condiciones);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total FROM vw_estado_cuenta_cliente ${filtro}`,
    valores,
  );

  const filas = await consultar<{
    cliente_id: string;
    cliente: string;
    saldo_actual: string;
    ultima_venta: Date | string | null;
    ultimo_pago: Date | string | null;
  }>(
    cliente,
    `SELECT cliente_id, cliente, saldo_actual, ultima_venta, ultimo_pago
       FROM vw_estado_cuenta_cliente
       ${filtro}
     ORDER BY saldo_actual DESC, cliente
     ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      // `cliente_id` es BIGINT: node-postgres lo entrega como texto para no
      // perder precision. Del otro lado del cable es un numero.
      cliente_id: Number(f.cliente_id),
      cliente: f.cliente,
      saldo_actual: Number(f.saldo_actual),
      // `fechaComoTexto` evita el corrimiento de un dia que trae
      // `toISOString()` en un huso negativo, y el null se conserva tal cual.
      ultima_venta: f.ultima_venta === null ? null : fechaComoTexto(f.ultima_venta),
      ultimo_pago: f.ultimo_pago === null ? null : fechaComoTexto(f.ultimo_pago),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

/**
 * El cliente por id, o `null` si no existe.
 *
 * Se usa para el 404 de la hoja y para saber a quien se la escribimos; el
 * nombre no va en el nombre del archivo, que es el mismo criterio de privacidad
 * que las notas (ver `servicio.ts`).
 */
export async function buscarCliente(
  cliente: PoolClient,
  clienteId: number,
): Promise<{ cliente_id: number; cliente: string } | null> {
  const fila = await consultarUno<{ cliente_id: string; cliente: string }>(
    cliente,
    `SELECT id AS cliente_id, nombre AS cliente FROM clientes WHERE id = $1`,
    [clienteId],
  );
  if (fila === null) return null;
  return { cliente_id: Number(fila.cliente_id), cliente: fila.cliente };
}

/** La venta cruda de la que la hoja saca su reglon. */
interface VentaCruda {
  fecha: string;
  serie: string;
  folio_numero: string;
  monto: string;
}

/** El abono crudo de la que la hoja saca su reglon. */
interface AbonoCrudo {
  fecha: string;
  // `pagos.metodo` admite NULL (un abono que no se anoto con que se hizo), asi
  // que la hoja lo recibe como tal y no como una cadena que miente.
  metodo: string | null;
  monto: string;
}

/**
 * Las ventas y los abonos del cliente, por separado y ya ordenados por fecha.
 *
 * Se leen por separado y se combinan en TypeScript en vez de hacer un `UNION`
 * porque cada lado trae sus propias columnas (la venta el folio de su nota, el
 * abono su metodo) y el orden de empate no es trivial: primero la venta y luego
 * el abono del mismo dia, que es como se ve en el mostrador.
 */
export async function leerMovimientos(
  cliente: PoolClient,
  clienteId: number,
): Promise<{ ventas: VentaCruda[]; abonos: AbonoCrudo[] }> {
  const [ventas, abonos] = await Promise.all([
    consultar<VentaCruda>(
      cliente,
      `SELECT n.fecha::TEXT AS fecha, f.serie, f.folio_numero::TEXT, n.subtotal::TEXT AS monto
         FROM notas_remision n
         JOIN folios f ON f.id = n.folio_id
        WHERE n.cliente_id = $1
          AND n.estatus <> 'cancelada'
        ORDER BY n.fecha, n.id`,
      [clienteId],
    ),
    consultar<AbonoCrudo>(
      cliente,
      `SELECT p.fecha::TEXT AS fecha, p.metodo, p.monto::TEXT AS monto
         FROM pagos p
        WHERE p.cliente_id = $1
        ORDER BY p.fecha, p.id`,
      [clienteId],
    ),
  ]);

  return { ventas, abonos };
}
