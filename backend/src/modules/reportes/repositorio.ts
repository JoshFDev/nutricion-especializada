import type { PoolClient } from 'pg';
import { contar, consultar } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import type {
  ReporteAlertas,
  ReporteConsumo,
  ReporteEstadoCuenta,
  ReporteExistencia,
} from './esquemas.js';
import type {
  Listado,
  RenglonAlerta,
  RenglonConsumo,
  RenglonEstadoCuenta,
  RenglonExistencia,
} from './modelo.js';

/**
 * SQL de los tres reportes.
 *
 * Todos leen de las vistas de 0001 y no de las tablas. La diferencia con
 * auditoria es a proposito: alli se leia la tabla porque las vistas no traian
 * los ids y sin ids no se puede filtrar; aqui las vistas ya traen
 * `producto_id`, `cliente_id` y `almacen_id`, asi que leer la vista es leer
 * una definicion (la de 0001) en vez de rearmar los mismos JOINs en cada
 * consulta.
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

// ----------------------------------------------------------- existencia
export async function listarExistencia(
  cliente: PoolClient,
  q: ReporteExistencia,
): Promise<Listado<RenglonExistencia>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.almacen_id !== undefined) {
    valores.push(q.almacen_id);
    condiciones.push(`almacen_id = $${valores.length}`);
  }
  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(`(codigo ILIKE $${valores.length} OR nombre ILIKE $${valores.length})`);
  }
  if (q.solo_con_existencia) {
    // El filtro va en el HAVING de la vista ya resuelta, no hace falta
    // agrupar de nuevo: la vista ya trae una suma por producto y bodega.
    condiciones.push('existencia_bultos <> 0');
  }

  const filtro = donde(condiciones);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total FROM vw_existencia_actual ${filtro}`,
    valores,
  );

  const filas = await consultar<{
    producto_id: string;
    codigo: string;
    nombre: string;
    almacen_id: number;
    almacen: string;
    existencia_bultos: string;
  }>(
    cliente,
    `SELECT producto_id, codigo, nombre, almacen_id, almacen, existencia_bultos
       FROM vw_existencia_actual
       ${filtro}
     ORDER BY nombre, codigo, almacen
     ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      // `producto_id` es BIGINT: node-postgres lo entrega como texto para no
      // perder precision. Del otro lado del cable es un numero.
      producto_id: Number(f.producto_id),
      codigo: f.codigo,
      producto: f.nombre,
      almacen_id: f.almacen_id,
      almacen: f.almacen,
      existencia_bultos: Number(f.existencia_bultos),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

// -------------------------------------------------------------- consumo
export async function listarConsumo(
  cliente: PoolClient,
  q: ReporteConsumo,
): Promise<Listado<RenglonConsumo>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.cliente_id !== undefined) {
    valores.push(q.cliente_id);
    condiciones.push(`cliente_id = $${valores.length}`);
  }
  if (q.producto_id !== undefined) {
    valores.push(q.producto_id);
    condiciones.push(`producto_id = $${valores.length}`);
  }
  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(`(cliente ILIKE $${valores.length} OR producto ILIKE $${valores.length})`);
  }

  const filtro = donde(condiciones);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total FROM vw_consumo_semanal_promedio ${filtro}`,
    valores,
  );

  const filas = await consultar<{
    cliente_id: string;
    cliente: string;
    producto_id: string;
    producto: string;
    kg_promedio_semanal: string;
  }>(
    cliente,
    `SELECT cliente_id, cliente, producto_id, producto, kg_promedio_semanal
       FROM vw_consumo_semanal_promedio
       ${filtro}
     ORDER BY cliente, producto
     ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      cliente_id: Number(f.cliente_id),
      cliente: f.cliente,
      producto_id: Number(f.producto_id),
      producto: f.producto,
      kg_promedio_semanal: Number(f.kg_promedio_semanal),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

// -------------------------------------------------------- estado de cuenta
export async function listarEstadoCuenta(
  cliente: PoolClient,
  q: ReporteEstadoCuenta,
): Promise<Listado<RenglonEstadoCuenta>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(`cliente ILIKE $${valores.length}`);
  }
  if (q.solo_con_saldo) {
    // Los que deben (o tienen saldo a favor) y no los que ya estan en cero.
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
      cliente_id: Number(f.cliente_id),
      cliente: f.cliente,
      saldo_actual: Number(f.saldo_actual),
      // `ultima_venta` y `ultimo_pago` son DATE (o NULL): `fechaComoTexto`
      // evita el corrimiento de un dia que trae `toISOString()` en un huso
      // negativo, y el null se conserva tal cual.
      ultima_venta: f.ultima_venta === null ? null : fechaComoTexto(f.ultima_venta),
      ultimo_pago: f.ultimo_pago === null ? null : fechaComoTexto(f.ultimo_pago),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

// --------------------------------------------------------------- alertas
/**
 * Las alertas de la base, de la mas nueva a la mas vieja.
 *
 * A diferencia de los otros tres reportes, este NO lee de una vista: la
 * tabla `alertas` se llena desde un trigger y no tiene vista. Se filtra por
 * tipo y por si ya se atendio, y se pagina.
 */
export async function listarAlertas(
  cliente: PoolClient,
  q: ReporteAlertas,
): Promise<Listado<RenglonAlerta>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.tipo !== undefined) {
    valores.push(q.tipo);
    condiciones.push(`tipo = $${valores.length}`);
  }
  if (q.atendida) {
    condiciones.push('atendida');
  }

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total FROM alertas ${donde(condiciones)}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    tipo: string;
    descripcion: string;
    tabla_origen: string | null;
    registro_id: string | null;
    atendida: boolean;
    creado_en: Date;
  }>(
    cliente,
    `SELECT id, tipo, descripcion, tabla_origen, registro_id, atendida, creado_en
       FROM alertas
       ${donde(condiciones)}
      ORDER BY creado_en DESC, id DESC
      ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      tipo: f.tipo,
      descripcion: f.descripcion,
      tabla_origen: f.tabla_origen,
      registro_id: f.registro_id === null ? null : Number(f.registro_id),
      atendida: f.atendida,
      creado_en: f.creado_en.toISOString(),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

// ------------------------------------------------------ conciliacion caja
/**
 * Los cobros de la cartera y los movimientos de la caja, uno contra otro.
 *
 * Un cobro se anota en DOS tablas: en `pagos` (lo que el cliente debe) y en
 * `movimientos_financieros` (de donde salio el dinero). La migracion 0024
 * dejo el vinculo entre las dos (`movimientos_financieros.pago_id`), y esto
 * es lo que se puede hacer con el.
 *
 * Lo que se busca:
 *
 *   - `pagos_sin_movimiento`: un cobro que llego a la cartera pero no a la
 *     caja. Es dinero que se conto y no se registro.
 *   - `movimientos_con_otro_monto`: el movimiento existe pero no por el
 *     mismo dinero. Salen cuando alguien corrigio el pago a mano.
 *   - `pagos_con_dos_movimientos`: dos movimientos para el mismo cobro. El
 *     indice unico de 0024 lo impide, asi que esto deberia salir siempre en
 *     cero: esta ahi para que se note si el indice se llegara a quitar.
 *
 * Los movimientos que NO vienen de un cobro (renta, flete, nomina) no se
 * cuentan como faltantes: no son cobros.
 */
export async function conciliacionCaja(cliente: PoolClient): Promise<{
  pagos_sin_movimiento: { id: number; cliente: string | null; monto: number; fecha: string }[];
  movimientos_con_otro_monto: {
    pago_id: number;
    movimiento_id: number;
    monto_pago: number;
    monto_movimiento: number;
  }[];
  pagos_con_dos_movimientos: { pago_id: number; movimientos: number }[];
}> {
  const sinMovimiento = await consultar<{
    id: string;
    cliente: string | null;
    monto: string;
    fecha: Date | string;
  }>(
    cliente,
    `SELECT p.id, c.nombre AS cliente, p.monto::TEXT AS monto, p.fecha
       FROM pagos p
       LEFT JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN movimientos_financieros m ON m.pago_id = p.id
      WHERE m.id IS NULL
      ORDER BY p.fecha DESC, p.id DESC
      LIMIT 200`,
  );

  const otroMonto = await consultar<{
    pago_id: string;
    movimiento_id: string;
    monto_pago: string;
    monto_movimiento: string;
  }>(
    cliente,
    `SELECT p.id AS pago_id, m.id AS movimiento_id,
            p.monto::TEXT AS monto_pago, m.monto::TEXT AS monto_movimiento
       FROM pagos p
       JOIN movimientos_financieros m ON m.pago_id = p.id
      WHERE p.monto <> m.monto
      ORDER BY p.id DESC
      LIMIT 200`,
  );

  const dosMovimientos = await consultar<{ pago_id: string; movimientos: string }>(
    cliente,
    `SELECT p.id AS pago_id, count(m.id)::TEXT AS movimientos
       FROM pagos p
       JOIN movimientos_financieros m ON m.pago_id = p.id
      GROUP BY p.id
     HAVING count(m.id) > 1
      LIMIT 200`,
  );

  return {
    pagos_sin_movimiento: sinMovimiento.map((p) => ({
      id: Number(p.id),
      cliente: p.cliente,
      monto: Number(p.monto),
      fecha: fechaComoTexto(p.fecha),
    })),
    movimientos_con_otro_monto: otroMonto.map((m) => ({
      pago_id: Number(m.pago_id),
      movimiento_id: Number(m.movimiento_id),
      monto_pago: Number(m.monto_pago),
      monto_movimiento: Number(m.monto_movimiento),
    })),
    pagos_con_dos_movimientos: dosMovimientos.map((m) => ({
      pago_id: Number(m.pago_id),
      movimientos: Number(m.movimientos),
    })),
  };
}
