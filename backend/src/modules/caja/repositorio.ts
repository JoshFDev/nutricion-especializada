import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import type {
  Cierre,
  CrearCuenta,
  CrearMovimiento,
  ListarCuentas,
  ListarMovimientos,
  Resumen,
} from './esquemas.js';
import type {
  FilaCierre,
  FilaCuenta,
  FilaMovimiento,
  Listado,
  MovimientoListado,
  ResumenCuenta,
} from './modelo.js';

/**
 * SQL de caja y bancos.
 *
 * Lo que la base ya resuelve y aqui NO se reimplementa: el saldo de la cuenta
 * (`fn_recalcular_saldo_cuenta` recalcula desde cero en cada INSERT, UPDATE y
 * DELETE) y la fila de auditoria con el saldo antes y despues
 * (`fn_auditar_caja`). Por eso ninguna consulta de aqui lee ni escribe
 * `cuentas_financieras.saldo_actual`: se lee para MOSTRARLO, nunca para
 * calcularlo.
 */

const COLUMNAS_MOVIMIENTO = `
  m.id, m.cuenta_id, m.fecha, m.tipo, m.categoria, m.cliente_id, m.proveedor_id,
  m.monto, m.descripcion, m.tiene_factura, m.creado_en,
  cf.nombre AS cuenta_nombre, cf.tipo AS cuenta_tipo,
  c.nombre  AS cliente_nombre,
  p.nombre  AS proveedor_nombre
`;

const DESDE_MOVIMIENTO = `
  FROM movimientos_financieros m
  JOIN cuentas_financieras cf ON cf.id = m.cuenta_id
  LEFT JOIN clientes c   ON c.id = m.cliente_id
  LEFT JOIN proveedores p ON p.id = m.proveedor_id
`;

/**
 * `total` y las filas usan el MISMO `FROM`, y no es descuido: `buscar` filtra
 * por `cf.nombre`, y contar con un `FROM` mas pobre que el de las filas deja
 * la columna fuera del alcance. Los tres JOIN son 1:1 (`cuentas_financieras`
 * por id, `clientes` y `proveedores` por id), asi que contar sobre el `FROM`
 * completo no multiplica filas ni falsea el total.
 */

export async function listarCuentas(cliente: PoolClient, q: ListarCuentas): Promise<FilaCuenta[]> {
  const valores: unknown[] = [];
  let donde = '';

  if (q.tipo !== undefined) {
    valores.push(q.tipo);
    donde = `WHERE tipo = $1`;
  }

  return consultar<FilaCuenta>(
    cliente,
    `SELECT id, nombre, tipo, banco, titular, saldo_actual
       FROM cuentas_financieras
       ${donde}
      ORDER BY tipo, nombre`,
    valores,
  );
}

export async function consultarCuenta(cliente: PoolClient, id: number): Promise<FilaCuenta | null> {
  return consultarUno<FilaCuenta>(
    cliente,
    `SELECT id, nombre, tipo, banco, titular, saldo_actual
       FROM cuentas_financieras WHERE id = $1`,
    [id],
  );
}

export async function existeNombreCuenta(
  cliente: PoolClient,
  nombre: string,
  exceptoId?: number,
): Promise<boolean> {
  const f = await consultarUno<{ ok: boolean }>(
    cliente,
    exceptoId === undefined
      ? `SELECT TRUE AS ok FROM cuentas_financieras WHERE nombre = $1`
      : `SELECT TRUE AS ok FROM cuentas_financieras WHERE nombre = $1 AND id <> $2`,
    exceptoId === undefined ? [nombre] : [nombre, exceptoId],
  );
  return f !== null;
}

export async function crearCuenta(cliente: PoolClient, d: CrearCuenta): Promise<FilaCuenta> {
  const f = await consultarUno<FilaCuenta>(
    cliente,
    `INSERT INTO cuentas_financieras (nombre, tipo, banco, titular)
     VALUES ($1, $2, $3, $4)
     RETURNING id, nombre, tipo, banco, titular, saldo_actual`,
    [d.nombre, d.tipo, d.banco ?? null, d.titular ?? null],
  );
  if (!f) throw new Error('El INSERT de cuenta no devolvio fila');
  return f;
}

/**
 * Candado sobre la cuenta, hasta el COMMIT.
 *
 * Es la misma carrera que `candearNota` evita en pagos, y aqui es mas grave
 * porque el saldo SI se pierde.
 *
 * `fn_recalcular_saldo_cuenta` recalcula el saldo sumando los movimientos de
 * la cuenta, y lo hace en un trigger AFTER de cada INSERT. En READ COMMITTED
 * cada sentencia ve un fotograma nuevo, asi que dos cajas registrando al
 * mismo tiempo hacen esto:
 *
 *   T1 inserta el movimiento A -> su trigger suma y ve A, todavia no ve B
 *   T2 inserta el movimiento B -> su trigger suma y ve B, todavia no ve A
 *
 * Las dos escriben `saldo_actual` y la que hace COMMIT ultimo pisa a la otra:
 * el saldo se queda sin uno de los dos movimientos, y no se Arregla sola,
 * porque no vuelve a dispararse el trigger. El mismo agujero aparece en la
 * fila de `auditoria_caja`, cuyo `saldo_despues` es la misma suma.
 *
 * Con el candado, T2 espera a que T1 cierre su transaccion y su suma ya ve
 * el movimiento de T1. El deadlock no es posible: es una sola fila y todas
 * las escrituras la piden en el mismo orden.
 */
export async function candearCuenta(cliente: PoolClient, id: number): Promise<void> {
  await cliente.query('SELECT id FROM cuentas_financieras WHERE id = $1 FOR UPDATE', [id]);
}

export async function clienteExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const f = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM clientes WHERE id = $1`,
    [id],
  );
  return f !== null;
}

export async function proveedorExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const f = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM proveedores WHERE id = $1`,
    [id],
  );
  return f !== null;
}

export async function crearMovimiento(
  cliente: PoolClient,
  d: CrearMovimiento & { fecha: string },
): Promise<number> {
  const f = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO movimientos_financieros
        (cuenta_id, fecha, tipo, categoria, cliente_id, proveedor_id, monto,
         descripcion, tiene_factura)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      d.cuenta_id,
      d.fecha,
      d.tipo,
      d.categoria,
      d.cliente_id ?? null,
      d.proveedor_id ?? null,
      d.monto,
      d.descripcion ?? null,
      d.tiene_factura,
    ],
  );
  return Number(f?.id);
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

export async function borrarMovimiento(cliente: PoolClient, id: number): Promise<boolean> {
  const r = await cliente.query(`DELETE FROM movimientos_financieros WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Las categorias que ya se usaron, para el desplegable del formulario. */
export async function categorias(
  cliente: PoolClient,
  cuentaId?: number,
): Promise<{ categoria: string; movimientos: number }[]> {
  const valores: unknown[] = [];
  let donde = '';

  if (cuentaId !== undefined) {
    valores.push(cuentaId);
    donde = 'WHERE cuenta_id = $1';
  }

  const filas = await consultar<{ categoria: string; movimientos: string }>(
    cliente,
    `SELECT categoria, count(*)::TEXT AS movimientos
       FROM movimientos_financieros
       ${donde}
      GROUP BY categoria
      ORDER BY categoria`,
    valores,
  );
  return filas.map((f) => ({ categoria: f.categoria, movimientos: Number(f.movimientos) }));
}

const construirFiltro = (q: ListarMovimientos) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.cuenta_id !== undefined) {
    valores.push(q.cuenta_id);
    condiciones.push(`m.cuenta_id = $${valores.length}`);
  }
  if (q.tipo !== undefined) {
    valores.push(q.tipo);
    condiciones.push(`m.tipo = $${valores.length}`);
  }
  if (q.categoria !== undefined) {
    valores.push(q.categoria);
    condiciones.push(`m.categoria = $${valores.length}`);
  }
  if (q.cliente_id !== undefined) {
    valores.push(q.cliente_id);
    condiciones.push(`m.cliente_id = $${valores.length}`);
  }
  if (q.proveedor_id !== undefined) {
    valores.push(q.proveedor_id);
    condiciones.push(`m.proveedor_id = $${valores.length}`);
  }
  if (q.con_factura !== undefined) {
    valores.push(q.con_factura);
    condiciones.push(`m.tiene_factura = $${valores.length}`);
  }
  if (q.desde !== undefined) {
    valores.push(q.desde);
    condiciones.push(`m.fecha >= $${valores.length}::date`);
  }
  if (q.hasta !== undefined) {
    valores.push(q.hasta);
    condiciones.push(`m.fecha <= $${valores.length}::date`);
  }
  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(cf.nombre ILIKE $${valores.length}
        OR m.categoria ILIKE $${valores.length}
        OR m.descripcion ILIKE $${valores.length})`,
    );
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '',
  };
};

export async function listarMovimientos(
  cliente: PoolClient,
  q: ListarMovimientos,
): Promise<Listado<MovimientoListado>> {
  const { valores, donde } = construirFiltro(q);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total ${DESDE_MOVIMIENTO} ${donde}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    cuenta_id: number;
    cuenta_nombre: string;
    fecha: Date | string;
    tipo: MovimientoListado['tipo'];
    categoria: string;
    cliente_nombre: string | null;
    proveedor_nombre: string | null;
    monto: string;
    tiene_factura: boolean;
  }>(
    cliente,
    `SELECT m.id, m.cuenta_id, m.fecha, m.tipo, m.categoria, m.monto, m.tiene_factura,
            cf.nombre AS cuenta_nombre,
            c.nombre  AS cliente_nombre,
            p.nombre  AS proveedor_nombre
       ${DESDE_MOVIMIENTO}
       ${donde}
     ORDER BY m.fecha DESC, m.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      cuenta_id: f.cuenta_id,
      cuenta: f.cuenta_nombre,
      fecha: fechaComoTexto(f.fecha),
      tipo: f.tipo,
      categoria: f.categoria,
      cliente: f.cliente_nombre,
      proveedor: f.proveedor_nombre,
      monto: Number(f.monto),
      tiene_factura: f.tiene_factura,
    })),
    total,
    limite: q.limite,
    offset: q.offset,
  };
}

/**
 * El periodo por cuenta.
 *
 * El `LEFT JOIN` con la cuenta es lo que hace que aparezca una cuenta sin un
 * solo movimiento en el periodo: en un dia que solo hubo un ingreso, las
 * demas cuentas en cero son informacion, no ruido. Y el `GROUP BY` es sobre
 * la cuenta, no sobre el movimiento, asi que una cuenta con veinte
 * movimientos es una fila.
 *
 * `saldo_actual` se lee de `cuentas_financieras`, no de la misma suma: es el
 * saldo completo de la cuenta y el `saldo_periodo` es solo el del rango.
 */
export async function resumenPorCuenta(cliente: PoolClient, q: Resumen): Promise<ResumenCuenta[]> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.desde !== undefined) {
    valores.push(q.desde);
    condiciones.push(`m.fecha >= $${valores.length}::date`);
  }
  if (q.hasta !== undefined) {
    valores.push(q.hasta);
    condiciones.push(`m.fecha <= $${valores.length}::date`);
  }
  const donde = condiciones.length > 0 ? `AND ${condiciones.join('\n    AND ')}` : '';

  const filas = await consultar<{
    cuenta_id: number;
    cuenta: string;
    tipo: ResumenCuenta['tipo'];
    ingresos: string;
    egresos: string;
    movimientos: string;
    saldo_actual: string;
  }>(
    cliente,
    `SELECT cf.id AS cuenta_id, cf.nombre AS cuenta, cf.tipo,
            cf.saldo_actual,
            COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE 0 END), 0)::TEXT AS ingresos,
            COALESCE(SUM(CASE WHEN m.tipo = 'egreso'  THEN m.monto ELSE 0 END), 0)::TEXT AS egresos,
            count(m.id)::TEXT AS movimientos
       FROM cuentas_financieras cf
       LEFT JOIN movimientos_financieros m
              ON m.cuenta_id = cf.id
              ${donde}
      GROUP BY cf.id, cf.nombre, cf.tipo, cf.saldo_actual
      ORDER BY cf.tipo, cf.nombre`,
    valores,
  );

  return filas.map((f) => {
    const ingresos = Number(f.ingresos);
    const egresos = Number(f.egresos);
    return {
      cuenta_id: f.cuenta_id,
      cuenta: f.cuenta,
      tipo: f.tipo,
      ingresos,
      egresos,
      saldo_periodo: Number((ingresos - egresos).toFixed(2)),
      saldo_actual: Number(f.saldo_actual),
      movimientos: Number(f.movimientos),
    };
  });
}

/**
 * El arqueo esperado de cada cuenta para UN dia.
 *
 * A diferencia del resumen, que suma un rango, aqui el dia parte la historia
 * en dos y las tres cifras salen de la MISMA pasada sobre los movimientos de
 * la cuenta:
 *
 *   - `fondo`: lo que entro menos lo que salio con `fecha < dia`. Es el saldo
 *     con el que arranca la manana, y sale de la base y no de restar a mano,
 *     porque el saldo de la cuenta arrastra toda su historia.
 *   - `ingresos` / `egresos`: lo del dia exacto (`fecha = dia`).
 *   - `esperado`: el fondo mas lo del dia, o sea `fecha <= dia`. Esa es la
 *     cifra contra la que se cuenta el efectivo al cerrar.
 *
 * `saldo_actual` se lee de `cuentas_financieras` y no de la suma: es el saldo
 * del sistema AHORA. Coincide con el esperado cuando el dia es hoy y no hay
 * movimientos con fecha futura; cuando no coincide, la diferencia son esos
 * movimientos futuros, que es justo lo que hay que ver al cerrar.
 *
 * El `LEFT JOIN` y el `GROUP BY` son los del resumen y por la misma razon:
 * una cuenta sin movimientos tiene que salir en cero, que es informacion, y
 * una cuenta con veinte movimientos es una sola fila.
 */
export async function cierrePorCuenta(
  cliente: PoolClient,
  q: Cierre & { fecha: string },
): Promise<FilaCierre[]> {
  return consultar<FilaCierre>(
    cliente,
    `SELECT cf.id AS cuenta_id, cf.nombre AS cuenta, cf.tipo,
            cf.saldo_actual,
            COALESCE(SUM(
              CASE WHEN m.fecha < $1::date THEN
                CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE -m.monto END
              END
            ), 0)::TEXT AS fondo,
            COALESCE(SUM(
              CASE WHEN m.fecha = $1::date AND m.tipo = 'ingreso' THEN m.monto ELSE 0 END
            ), 0)::TEXT AS ingresos,
            COALESCE(SUM(
              CASE WHEN m.fecha = $1::date AND m.tipo = 'egreso' THEN m.monto ELSE 0 END
            ), 0)::TEXT AS egresos,
            COALESCE(SUM(
              CASE WHEN m.fecha <= $1::date THEN
                CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE -m.monto END
              END
            ), 0)::TEXT AS esperado,
            count(m.id) FILTER (WHERE m.fecha = $1::date)::TEXT AS movimientos
       FROM cuentas_financieras cf
       LEFT JOIN movimientos_financieros m ON m.cuenta_id = cf.id
      GROUP BY cf.id, cf.nombre, cf.tipo, cf.saldo_actual
      ORDER BY cf.tipo, cf.nombre`,
    [q.fecha],
  );
}
