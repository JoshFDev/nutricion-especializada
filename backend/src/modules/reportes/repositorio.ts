import type { PoolClient } from 'pg';
import { contar, consultar } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import type { ReporteConsumo, ReporteEstadoCuenta, ReporteExistencia } from './esquemas.js';
import type { Listado, RenglonConsumo, RenglonEstadoCuenta, RenglonExistencia } from './modelo.js';

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
