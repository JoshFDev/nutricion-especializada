import type { PoolClient } from 'pg';
import { enTransaccionDe, hoyEnLaBase } from '../../db/transaccion.js';
import { Conflicto, ErrorValidacion, NoEncontrado } from '../../core/errores.js';
import { fechaComoTexto } from '../../core/valores.js';
import type {
  CrearCuenta,
  CrearMovimiento,
  ListarCuentas,
  ListarMovimientos,
  Resumen,
} from './esquemas.js';
import type { Cuenta, Listado, Movimiento, MovimientoListado, ResumenCuenta } from './modelo.js';
import * as repo from './repositorio.js';

/**
 * Caja y bancos.
 *
 * Es el unico modulo del proyecto con DELETE, y la razon de que los demas no
 * lo tengan esta aqui. Un cliente no se borra y un producto tampoco, porque
 * sus nombres aparecen en notas viejas y borrarlos deja documentos huerfanos.
 * Un movimiento de caja no tiene a quien aparecer: su unica huella es la fila
 * que `fn_auditar_caja` escribe en `auditoria_caja`, con el saldo antes y el
 * saldo despues. Por eso borrarlo no lo hace desaparecer: queda documentado
 * que se borro y cuando. Volverlo a capturar es otra operacion normal, no una
 * resurreccion.
 *
 * Lo que la base ya hace y aqui no se reimplementa: el saldo de la cuenta
 * (`fn_recalcular_saldo_cuenta`) y la auditoria con saldos (`fn_auditar_caja`).
 * Lo que la base NO puede hacer, y por eso vive en este archivo, son tres
 * cosas: que la cuenta exista (400 con el nombre del campo, no un 23503),
 * que el cliente o el proveedor existan (lo mismo), y el candado por cuenta
 * que serializa dos cajas registrando al mismo tiempo.
 *
 * Lo que NO se hace aqui, y es una decision y no un olvido: un egreso puede
 * dejar la cuenta en negativo. El esquema no lo prohibe (no hay CHECK) y en
 * un banco es real: una transferencia se registra el dia que se emite y el
 * saldo queda corrido hasta la compensacion. Bloquearlo dejaria movimientos
 * legitimos sin poder capturarse, y el operador resolveria el problema
 * metiendolos a otra cuenta, que es peor. El saldo se devuelve en cada
 * respuesta para que se vea.
 *
 * HUECO CONOCIDO, a proposito y no por olvido: capturar un pago NO registra
 * solo el movimiento de caja. `pagos` y `movimientos_financieros` son tablas
 * distintas y ningun trigger las une, asi que hoy un abono se anota dos
 * veces: una en `/api/pagos` (cartera) y otra en `/api/caja/movimientos`
 * (efectivo). Unirlos de verdad es un cambio de esquema, no un endpoint, asi
 * que queda para cuando se arme el frontend y se vea que pantalla lo pide.
 */

/**
 * Que exista a quien se le atribuye el movimiento.
 *
 * Sin esto, un `cliente_id` equivocado se guarda y el error sale como un
 * 23503 en la cara del operador, que dice "referencia en uso" cuando en
 * realidad lo que paso es que el id no existe. `pagos` hace lo mismo con su
 * `cliente_id`, y por el mismo motivo.
 */
async function exigirReferencias(cliente: PoolClient, d: CrearMovimiento): Promise<void> {
  if (d.cliente_id !== undefined && d.cliente_id !== null) {
    if (!(await repo.clienteExiste(cliente, d.cliente_id))) {
      throw new ErrorValidacion(`El cliente ${d.cliente_id} no existe`, [
        { campo: 'cliente_id', problema: `El cliente ${d.cliente_id} no existe` },
      ]);
    }
  }
  if (d.proveedor_id !== undefined && d.proveedor_id !== null) {
    if (!(await repo.proveedorExiste(cliente, d.proveedor_id))) {
      throw new ErrorValidacion(`El proveedor ${d.proveedor_id} no existe`, [
        { campo: 'proveedor_id', problema: `El proveedor ${d.proveedor_id} no existe` },
      ]);
    }
  }
}

export async function listarCuentas(cliente: PoolClient, q: ListarCuentas): Promise<Cuenta[]> {
  return (await repo.listarCuentas(cliente, q)).map((f) => ({
    id: f.id,
    nombre: f.nombre,
    tipo: f.tipo,
    banco: f.banco,
    titular: f.titular,
    saldo_actual: Number(f.saldo_actual),
  }));
}

export async function consultarCuenta(cliente: PoolClient, id: number): Promise<Cuenta> {
  const fila = await repo.consultarCuenta(cliente, id);
  if (!fila) throw new NoEncontrado(`No existe la cuenta ${id}`);
  return {
    id: fila.id,
    nombre: fila.nombre,
    tipo: fila.tipo,
    banco: fila.banco,
    titular: fila.titular,
    saldo_actual: Number(fila.saldo_actual),
  };
}

export async function crearCuenta(cliente: PoolClient, d: CrearCuenta): Promise<Cuenta> {
  // El UNIQUE de la base ya lo impide; esto es para el mensaje.
  if (await repo.existeNombreCuenta(cliente, d.nombre)) {
    throw new Conflicto('CUENTA_DUPLICADA', `Ya existe una cuenta con el nombre "${d.nombre}"`);
  }
  const fila = await repo.crearCuenta(cliente, d);
  return {
    id: fila.id,
    nombre: fila.nombre,
    tipo: fila.tipo,
    banco: fila.banco,
    titular: fila.titular,
    saldo_actual: Number(fila.saldo_actual),
  };
}

export async function listarMovimientos(
  cliente: PoolClient,
  q: ListarMovimientos,
): Promise<Listado<MovimientoListado>> {
  return repo.listarMovimientos(cliente, q);
}

export async function listarCategorias(
  cliente: PoolClient,
  cuentaId?: number,
): Promise<{ categoria: string; movimientos: number }[]> {
  return repo.categorias(cliente, cuentaId);
}

export async function consultarMovimiento(cliente: PoolClient, id: number): Promise<Movimiento> {
  const f = await repo.consultarMovimiento(cliente, id);
  if (!f) throw new NoEncontrado(`No existe el movimiento ${id}`);
  return mapear(f);
}

export async function crearMovimiento(
  cliente: PoolClient,
  d: CrearMovimiento,
): Promise<Movimiento> {
  return enTransaccionDe(cliente, async (c) => {
    if (!(await repo.consultarCuenta(c, d.cuenta_id))) {
      throw new ErrorValidacion(`La cuenta ${d.cuenta_id} no existe`, [
        { campo: 'cuenta_id', problema: `La cuenta ${d.cuenta_id} no existe` },
      ]);
    }

    // Antes de validar nada mas y antes de escribir: el candado tiene que
    // quedar tomado de aqui al COMMIT, o no serializa nada. Ver la nota de
    // `candearCuenta`, que es la parte que no es obvia.
    await repo.candearCuenta(c, d.cuenta_id);

    await exigirReferencias(c, d);

    const fecha = d.fecha ?? (await hoyEnLaBase(c));
    const id = await repo.crearMovimiento(c, { ...d, fecha });

    // Se relee del final de la transaccion, no se arma con lo que se mando:
    // el `saldo_actual` que devuelve lo acaba de calcular el trigger, que es
    // el unico que sabe la verdad.
    const fila = await repo.consultarMovimiento(c, id);
    if (!fila) throw new Error('El INSERT de movimiento no devolvio fila');
    return mapear(fila);
  });
}

export async function eliminarMovimiento(cliente: PoolClient, id: number): Promise<void> {
  await enTransaccionDe(cliente, async (c) => {
    const fila = await repo.consultarMovimiento(c, id);
    if (!fila) throw new NoEncontrado(`No existe el movimiento ${id}`);

    // Mismo candado que en el alta, por la misma razon: el DELETE tambien
    // dispara `fn_recalcular_saldo_cuenta`, y sin candado dos borrados
    // simultaneos de la misma cuenta se pisan el saldo igual que dos altas.
    await repo.candearCuenta(c, fila.cuenta_id);

    await repo.borrarMovimiento(c, id);
  });
}

export async function resumen(cliente: PoolClient, q: Resumen): Promise<ResumenCuenta[]> {
  return repo.resumenPorCuenta(cliente, q);
}

const mapear = (f: {
  id: string;
  cuenta_id: number;
  cuenta_nombre: string;
  cuenta_tipo: Movimiento['cuenta_tipo'];
  fecha: Date | string;
  tipo: Movimiento['tipo'];
  categoria: string;
  cliente_id: string | null;
  cliente_nombre: string | null;
  proveedor_id: string | null;
  proveedor_nombre: string | null;
  monto: string;
  descripcion: string | null;
  tiene_factura: boolean;
  creado_en: Date;
}): Movimiento => ({
  id: Number(f.id),
  cuenta_id: f.cuenta_id,
  cuenta: f.cuenta_nombre,
  cuenta_tipo: f.cuenta_tipo,
  fecha: fechaComoTexto(f.fecha),
  tipo: f.tipo,
  categoria: f.categoria,
  cliente_id: f.cliente_id === null ? null : Number(f.cliente_id),
  cliente: f.cliente_nombre,
  proveedor_id: f.proveedor_id === null ? null : Number(f.proveedor_id),
  proveedor: f.proveedor_nombre,
  monto: Number(f.monto),
  descripcion: f.descripcion,
  tiene_factura: f.tiene_factura,
  creado_en: f.creado_en.toISOString(),
});
