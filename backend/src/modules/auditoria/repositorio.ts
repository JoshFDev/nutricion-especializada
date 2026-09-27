import type { PoolClient } from 'pg';
import { contar, consultar } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import type {
  ListarAccesos,
  ListarAuditoriaCaja,
  ListarAuditoriaInventario,
  ListarAuditoriaPrecios,
  ListarLog,
} from './esquemas.js';
import type {
  Listado,
  RenglonAcceso,
  RenglonCaja,
  RenglonInventario,
  RenglonLog,
  RenglonPrecios,
} from './modelo.js';

/**
 * SQL de las bitacoras.
 *
 * Se lee de las TABLAS y no de las vistas `vw_auditoria_*` de 0001, y la
 * razon es el filtro por usuario. Las vistas traen el nombre del usuario
 * (que es lo que se ve en pantalla) pero no su `usuario_id`, asi que no se
 * pueden filtrar por el, y las vistas no tienen el `LEFT JOIN usuarios` que
 * hace falta para recuperarlo. Perder el filtro obligaria a que el frontend
 * filtrara por texto libre sobre el nombre, que no es lo mismo: "los cambios
 * de esta persona" y "los cambios que mencionen su nombre" no coinciden.
 *
 * Los indices que creo 0001 lo confirman: `idx_auditoria_caja_usuario`,
 * `idx_auditoria_inventario_usuario`, `idx_auditoria_precios_usuario` y
 * `idx_auditoria_log_usuario_fecha` son todos `(usuario_id, fecha DESC)`.
 * estan ahi para esto.
 */

/**
 * Las dos mitades de un rango de fechas, con la conversion que cada tipo de
 * columna necesita.
 *
 * `esDate` para columnas DATE (`auditoria_caja.fecha`), donde `<=` alcanza
 * porque `2026-06-01` ES ese dia. Para TIMESTAMP hace falta el `+ 1`: el
 * driver manda el texto a las 00:00:00, y `<= '2026-06-01'` sobre un
 * `2026-06-01 14:30:00` da falso, o sea que el dia final del reporte
 * desapareceria sin que nada lo delatara. Con `< (fecha + 1)` el dia entra
 * entero y no se cuela nada del siguiente.
 */
const rango = (
  columna: string,
  esDate: boolean,
  q: { desde?: string | undefined; hasta?: string | undefined },
  valores: unknown[],
): string[] => {
  const partes: string[] = [];
  if (q.desde !== undefined) {
    valores.push(q.desde);
    partes.push(`${columna} >= $${valores.length}::date`);
  }
  if (q.hasta !== undefined) {
    valores.push(q.hasta);
    partes.push(
      esDate
        ? `${columna} <= $${valores.length}::date`
        : `${columna} < ($${valores.length}::date + 1)`,
    );
  }
  return partes;
};

/** Junta las condiciones, o devuelve la cadena vacia si no hay ninguna. */
const donde = (condiciones: string[]): string =>
  condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '';

/**
 * El `LIMIT`/`OFFSET` va DESPUES de todos los filtros y sus numeros de `$`
 * siguen al ultimo filtro, asi que se calculan aqui y no en cada consulta.
 */
const pagina = (valores: unknown[]): string =>
  `LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`;

const paginacion = (valores: unknown[], q: { limite: number; offset: number }) => [
  ...valores,
  q.limite,
  q.offset,
];

// ------------------------------------------------------------------- log
export async function listarLog(cliente: PoolClient, q: ListarLog): Promise<Listado<RenglonLog>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.tabla !== undefined) {
    valores.push(q.tabla);
    condiciones.push(`a.tabla = $${valores.length}`);
  }
  if (q.operacion !== undefined) {
    valores.push(q.operacion);
    condiciones.push(`a.operacion = $${valores.length}`);
  }
  if (q.registro_id !== undefined) {
    valores.push(q.registro_id);
    condiciones.push(`a.registro_id = $${valores.length}`);
  }
  if (q.usuario_id !== undefined) {
    valores.push(q.usuario_id);
    condiciones.push(`a.usuario_id = $${valores.length}`);
  }
  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(a.tabla ILIKE $${valores.length}
        OR u.nombre ILIKE $${valores.length}
        OR u.apellido_paterno ILIKE $${valores.length})`,
    );
  }
  condiciones.push(...rango('a.fecha', false, q, valores));

  const desde = donde(condiciones);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total
       FROM auditoria_log a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       ${desde}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    fecha: Date;
    tabla: string;
    operacion: RenglonLog['operacion'];
    registro_id: string | null;
    usuario_id: string | null;
    usuario_nombre: string | null;
    usuario_paterno: string | null;
    usuario_rfc: string | null;
    usuario_ip: string | null;
    datos_anteriores: Record<string, unknown> | null;
    datos_nuevos: Record<string, unknown> | null;
  }>(
    cliente,
    `SELECT a.id, a.fecha, a.tabla, a.operacion, a.registro_id, a.usuario_id,
            a.usuario_ip, a.datos_anteriores, a.datos_nuevos,
            u.nombre AS usuario_nombre, u.apellido_paterno AS usuario_paterno,
            u.rfc AS usuario_rfc
       FROM auditoria_log a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       ${desde}
     ORDER BY a.fecha DESC, a.id DESC
     ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      fecha: f.fecha.toISOString(),
      tabla: f.tabla,
      operacion: f.operacion,
      registro_id: f.registro_id === null ? null : Number(f.registro_id),
      usuario_id: f.usuario_id === null ? null : Number(f.usuario_id),
      usuario: f.usuario_nombre === null ? null : `${f.usuario_nombre} ${f.usuario_paterno}`,
      usuario_rfc: f.usuario_rfc,
      usuario_ip: f.usuario_ip,
      datos_anteriores: f.datos_anteriores,
      datos_nuevos: f.datos_nuevos,
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

// --------------------------------------------------------------- accesos
export async function listarAccesos(
  cliente: PoolClient,
  q: ListarAccesos,
): Promise<Listado<RenglonAcceso>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.evento !== undefined) {
    valores.push(q.evento);
    condiciones.push(`aa.evento = $${valores.length}`);
  }
  if (q.usuario_id !== undefined) {
    valores.push(q.usuario_id);
    condiciones.push(`aa.usuario_id = $${valores.length}`);
  }
  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(u.nombre ILIKE $${valores.length}
        OR aa.usuario_intento ILIKE $${valores.length}
        OR aa.ip::TEXT ILIKE $${valores.length})`,
    );
  }
  condiciones.push(...rango('aa.creado_en', false, q, valores));

  const filtro = donde(condiciones);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total
       FROM auditoria_accesos aa
       LEFT JOIN usuarios u ON u.id = aa.usuario_id
       ${filtro}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    creado_en: Date;
    evento: RenglonAcceso['evento'];
    usuario_id: string | null;
    usuario_intento: string | null;
    usuario_nombre: string | null;
    usuario_paterno: string | null;
    usuario_rfc: string | null;
    ip: string | null;
    user_agent: string | null;
    detalle: string | null;
  }>(
    cliente,
    `SELECT aa.id, aa.creado_en, aa.evento, aa.usuario_id, aa.usuario_intento,
            aa.ip::TEXT AS ip, aa.user_agent, aa.detalle,
            u.nombre AS usuario_nombre, u.apellido_paterno AS usuario_paterno,
            u.rfc AS usuario_rfc
       FROM auditoria_accesos aa
       LEFT JOIN usuarios u ON u.id = aa.usuario_id
       ${filtro}
     ORDER BY aa.creado_en DESC, aa.id DESC
     ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      fecha: f.creado_en.toISOString(),
      evento: f.evento,
      usuario_id: f.usuario_id === null ? null : Number(f.usuario_id),
      usuario_intento: f.usuario_intento,
      // El nombre del usuario si se conoce; si no, lo que se tecleo. Es lo
      // mismo que hace `vw_auditoria_accesos` con COALESCE, y la razon de
      // que sea COALESCE y no un campo aparte es que un login fallido no
      // tiene usuario_id pero si tiene `usuario_intento`, que es justo el
      // dato que hace falta para Investigar.
      usuario:
        f.usuario_nombre === null ? f.usuario_intento : `${f.usuario_nombre} ${f.usuario_paterno}`,
      usuario_rfc: f.usuario_rfc,
      ip: f.ip,
      user_agent: f.user_agent,
      detalle: f.detalle,
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

// ------------------------------------------------------------------ caja
export async function listarCaja(
  cliente: PoolClient,
  q: ListarAuditoriaCaja,
): Promise<Listado<RenglonCaja>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.cuenta_id !== undefined) {
    valores.push(q.cuenta_id);
    condiciones.push(`ac.cuenta_id = $${valores.length}`);
  }
  if (q.usuario_id !== undefined) {
    valores.push(q.usuario_id);
    condiciones.push(`ac.usuario_id = $${valores.length}`);
  }
  if (q.tipo !== undefined) {
    valores.push(q.tipo);
    condiciones.push(`ac.tipo = $${valores.length}`);
  }
  // `ac.fecha` es la fecha que el operador capturo (DATE) y `ac.creado_en` es
  // cuando se escribio la fila (TIMESTAMP). Las dos se filtran, y por el
  // mismo criterio: un reporte de "hoy" quiere las dos iguales.
  condiciones.push(...rango('ac.fecha', true, q, valores));
  condiciones.push(...rango('ac.creado_en', false, q, valores));

  const filtro = donde(condiciones);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total
       FROM auditoria_caja ac
       ${filtro}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    movimiento_id: string | null;
    cuenta_id: number;
    usuario_id: string | null;
    fecha: Date | string;
    operacion: RenglonCaja['operacion'];
    tipo: RenglonCaja['tipo'];
    categoria: string;
    monto: string;
    saldo_antes: string | null;
    saldo_despues: string | null;
    descripcion: string | null;
    creado_en: Date;
    cuenta_nombre: string;
    cuenta_tipo: RenglonCaja['cuenta_tipo'];
    cliente_nombre: string | null;
    proveedor_nombre: string | null;
    usuario_nombre: string | null;
    usuario_paterno: string | null;
  }>(
    cliente,
    `SELECT ac.id, ac.movimiento_id, ac.cuenta_id, ac.usuario_id,
            ac.fecha, ac.operacion, ac.tipo, ac.categoria, ac.monto,
            ac.saldo_antes, ac.saldo_despues, ac.descripcion, ac.creado_en,
            cf.nombre AS cuenta_nombre, cf.tipo AS cuenta_tipo,
            c.nombre  AS cliente_nombre,
            p.nombre  AS proveedor_nombre,
            u.nombre AS usuario_nombre, u.apellido_paterno AS usuario_paterno
       FROM auditoria_caja ac
       JOIN cuentas_financieras cf ON cf.id = ac.cuenta_id
       LEFT JOIN usuarios u ON u.id = ac.usuario_id
       -- El cliente y el proveedor se sacan del movimiento, y no de la
       -- auditoria: la tabla auditoria_caja no los tiene, solo tiene el
       -- movimiento_id. El JOIN es a la tabla, no a la vista, y por eso
       -- el movimiento borrado los deja en NULL en vez de sacar la fila.
       LEFT JOIN movimientos_financieros m ON m.id = ac.movimiento_id
       LEFT JOIN clientes c   ON c.id = m.cliente_id
       LEFT JOIN proveedores p ON p.id = m.proveedor_id
       ${filtro}
     ORDER BY ac.creado_en DESC, ac.id DESC
     ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      movimiento_id: f.movimiento_id === null ? null : Number(f.movimiento_id),
      cuenta_id: f.cuenta_id,
      usuario_id: f.usuario_id === null ? null : Number(f.usuario_id),
      fecha: fechaComoTexto(f.fecha),
      operacion: f.operacion,
      tipo: f.tipo,
      categoria: f.categoria,
      monto: Number(f.monto),
      saldo_antes: f.saldo_antes === null ? null : Number(f.saldo_antes),
      saldo_despues: f.saldo_despues === null ? null : Number(f.saldo_despues),
      descripcion: f.descripcion,
      cuenta: f.cuenta_nombre,
      cuenta_tipo: f.cuenta_tipo,
      cliente: f.cliente_nombre,
      proveedor: f.proveedor_nombre,
      // '(sistema)' y no null: un movimiento cargado por un script o por el
      // seed no tiene usuario, y en una bitacora "quien lo hizo" siempre
      // tiene que tener algo. Es lo que hacen las vistas de 0001.
      usuario: f.usuario_nombre === null ? '(sistema)' : `${f.usuario_nombre} ${f.usuario_paterno}`,
      creado_en: f.creado_en.toISOString(),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

// ------------------------------------------------------------ inventario
export async function listarInventario(
  cliente: PoolClient,
  q: ListarAuditoriaInventario,
): Promise<Listado<RenglonInventario>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.producto_id !== undefined) {
    valores.push(q.producto_id);
    condiciones.push(`ai.producto_id = $${valores.length}`);
  }
  if (q.almacen_id !== undefined) {
    valores.push(q.almacen_id);
    condiciones.push(`ai.almacen_id = $${valores.length}`);
  }
  if (q.usuario_id !== undefined) {
    valores.push(q.usuario_id);
    condiciones.push(`ai.usuario_id = $${valores.length}`);
  }
  condiciones.push(...rango('ai.creado_en', false, q, valores));

  const filtro = donde(condiciones);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total FROM auditoria_inventario ai ${filtro}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    producto_id: string;
    almacen_id: number;
    usuario_id: string | null;
    creado_en: Date;
    operacion: RenglonInventario['operacion'];
    tipo: string;
    cantidad_bultos: string;
    existencia_antes: string | null;
    existencia_despues: string | null;
    motivo: string | null;
    producto_codigo: string;
    producto_nombre: string;
    almacen_nombre: string;
    usuario_nombre: string | null;
    usuario_paterno: string | null;
  }>(
    cliente,
    `SELECT ai.id, ai.producto_id, ai.almacen_id, ai.usuario_id, ai.creado_en,
            ai.operacion, ai.tipo, ai.cantidad_bultos,
            ai.existencia_antes, ai.existencia_despues, ai.motivo,
            pr.codigo AS producto_codigo, pr.nombre AS producto_nombre,
            a.nombre AS almacen_nombre,
            u.nombre AS usuario_nombre, u.apellido_paterno AS usuario_paterno
       FROM auditoria_inventario ai
       JOIN productos pr ON pr.id = ai.producto_id
       JOIN almacenes a  ON a.id  = ai.almacen_id
       LEFT JOIN usuarios u ON u.id = ai.usuario_id
       ${filtro}
     ORDER BY ai.creado_en DESC, ai.id DESC
     ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      // `producto_id` es BIGINT y node-postgres devuelve los int8 como texto
      // para no perder precision. Aqui se convierte porque del otro lado del
      // cable el id de un producto SI es numero, y en la misma respuesta
      // `almacen_id` (SMALLINT) ya viene como numero: dejarlo textoeria hacer
      // que el mismo renglon tuviera los dos tipos.
      producto_id: Number(f.producto_id),
      almacen_id: f.almacen_id,
      usuario_id: f.usuario_id === null ? null : Number(f.usuario_id),
      fecha: f.creado_en.toISOString(),
      operacion: f.operacion,
      tipo: f.tipo,
      cantidad_bultos: Number(f.cantidad_bultos),
      existencia_antes: f.existencia_antes === null ? null : Number(f.existencia_antes),
      existencia_despues: f.existencia_despues === null ? null : Number(f.existencia_despues),
      motivo: f.motivo,
      producto_codigo: f.producto_codigo,
      producto: f.producto_nombre,
      almacen: f.almacen_nombre,
      usuario: f.usuario_nombre === null ? '(sistema)' : `${f.usuario_nombre} ${f.usuario_paterno}`,
      creado_en: f.creado_en.toISOString(),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

// --------------------------------------------------------------- precios
export async function listarPrecios(
  cliente: PoolClient,
  q: ListarAuditoriaPrecios,
): Promise<Listado<RenglonPrecios>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.producto_id !== undefined) {
    valores.push(q.producto_id);
    condiciones.push(`ap.producto_id = $${valores.length}`);
  }
  if (q.cliente_id !== undefined) {
    valores.push(q.cliente_id);
    condiciones.push(`ap.cliente_id = $${valores.length}`);
  }
  if (q.usuario_id !== undefined) {
    valores.push(q.usuario_id);
    condiciones.push(`ap.usuario_id = $${valores.length}`);
  }
  if (q.tipo_precio !== undefined) {
    valores.push(q.tipo_precio);
    condiciones.push(`ap.tipo_precio = $${valores.length}`);
  }
  condiciones.push(...rango('ap.creado_en', false, q, valores));

  const filtro = donde(condiciones);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total FROM auditoria_precios ap ${filtro}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    producto_id: string;
    cliente_id: string | null;
    proveedor_id: string | null;
    usuario_id: string | null;
    creado_en: Date;
    operacion: RenglonPrecios['operacion'];
    tipo_precio: RenglonPrecios['tipo_precio'];
    precio_anterior: string | null;
    precio_nuevo: string | null;
    variacion: string | null;
    motivo: string | null;
    producto_codigo: string;
    producto_nombre: string;
    cliente_nombre: string | null;
    proveedor_nombre: string | null;
    usuario_nombre: string | null;
    usuario_paterno: string | null;
  }>(
    cliente,
    `SELECT ap.id, ap.producto_id, ap.cliente_id, ap.proveedor_id, ap.usuario_id,
            ap.creado_en, ap.operacion, ap.tipo_precio,
            ap.precio_anterior, ap.precio_nuevo, ap.motivo,
            (ap.precio_nuevo - ap.precio_anterior)::TEXT AS variacion,
            pr.codigo AS producto_codigo, pr.nombre AS producto_nombre,
            c.nombre  AS cliente_nombre,
            pv.nombre AS proveedor_nombre,
            u.nombre AS usuario_nombre, u.apellido_paterno AS usuario_paterno
       FROM auditoria_precios ap
       JOIN productos pr  ON pr.id = ap.producto_id
       LEFT JOIN clientes c     ON c.id  = ap.cliente_id
       LEFT JOIN proveedores pv ON pv.id = ap.proveedor_id
       LEFT JOIN usuarios u ON u.id = ap.usuario_id
       ${filtro}
     ORDER BY ap.creado_en DESC, ap.id DESC
     ${pagina(valores)}`,
    paginacion(valores, q),
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      producto_id: Number(f.producto_id),
      cliente_id: f.cliente_id === null ? null : Number(f.cliente_id),
      proveedor_id: f.proveedor_id === null ? null : Number(f.proveedor_id),
      usuario_id: f.usuario_id === null ? null : Number(f.usuario_id),
      fecha: f.creado_en.toISOString(),
      operacion: f.operacion,
      tipo_precio: f.tipo_precio,
      precio_anterior: f.precio_anterior === null ? null : Number(f.precio_anterior),
      precio_nuevo: f.precio_nuevo === null ? null : Number(f.precio_nuevo),
      // La variacion la calcula la consulta y no el mapper, porque es
      // `precio_nuevo - precio_anterior` sobre NUMERIC: restarlo en JavaScript
      // introduce el ruido del double (3703.68 - 0 puede dar 3703.679999...).
      variacion: f.variacion === null ? null : Number(f.variacion),
      producto_codigo: f.producto_codigo,
      producto: f.producto_nombre,
      cliente: f.cliente_nombre,
      proveedor: f.proveedor_nombre,
      usuario: f.usuario_nombre === null ? '(sistema)' : `${f.usuario_nombre} ${f.usuario_paterno}`,
      motivo: f.motivo,
      creado_en: f.creado_en.toISOString(),
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}
