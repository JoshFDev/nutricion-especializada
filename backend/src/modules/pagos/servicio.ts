import type { PoolClient } from 'pg';
import { enTransaccionDe, hoyEnLaBase } from '../../db/transaccion.js';
import { Conflicto, ErrorValidacion, NoEncontrado, ReglaNegocio } from '../../core/errores.js';
import {
  mapearAplicacion,
  mapearPago,
  type AplicacionPago,
  type Listado,
  type Pago,
  type PagoListado,
} from './modelo.js';
import type { CrearPago, ListarPagos } from './esquemas.js';
import * as repo from './repositorio.js';
import * as cajaRepo from '../caja/repositorio.js';

/**
 * Reglas de cobranza.
 *
 * La base ya impide aplicar mas de lo recibido y mas de lo que debe una
 * nota (`fn_validar_aplicacion_pago`). Lo que la base NO puede saber, y que
 * es justo lo que sale mal en una caja, son tres cosas:
 *
 *   1. Que la nota sea del MISMO cliente que el pago. `pagos_aplicacion`
 *      no tiene FK que ligue `pago.cliente_id` con `nota.cliente_id`, asi
 *      que un pago del cliente 3 aplicado a una nota del cliente 7 se
 *      acepta, y el saldo de los dos queda mal: al del 3 se le descuenta
 *      dinero que no cubrio su deuda, y al 7 se le descuenta una nota que
 *      sigue impagada.
 *   2. Que la nota no este CANCELADA. El trigger compara contra el subtotal
 *      y no mira el estatus, y `fn_actualizar_estatus_por_aplicaciones`
 *      deja el estatus en 'cancelada' sin quejarse. O sea: el pago entra,
 *      descuenta saldo al cliente, y no cubre ninguna nota porque la nota
 *      que "cubria" ya no cuenta. Es dinero que desaparece de la cartera
 *      sin haber cobrado nada.
 *   3. Que el pago exista antes de aplicar. Por eso se inserta la cabecera
 *      y luego las aplicaciones, y no al reves.
 */

/** Centavos enteros, para no comparar dinero con doubles. */
const centavos = (valor: string | number): number => Math.round(Number(valor) * 100);

export async function listar(cliente: PoolClient, q: ListarPagos): Promise<Listado<PagoListado>> {
  return repo.listar(cliente, q);
}

export async function consultar(cliente: PoolClient, id: number): Promise<Pago> {
  return leer(cliente, id);
}

export async function crear(cliente: PoolClient, d: CrearPago): Promise<Pago> {
  return enTransaccionDe(cliente, async (c) => {
    if (!(await repo.clienteExiste(c, d.cliente_id))) {
      throw new ErrorValidacion(`El cliente ${d.cliente_id} no existe`, [
        { campo: 'cliente_id', problema: `El cliente ${d.cliente_id} no existe` },
      ]);
    }

    const fecha = d.fecha ?? (await hoyEnLaBase(c));

    /**
     * Candados ANTES de leer nada, y en orden de id.
     *
     * El orden es lo que evita el interbloqueo: si la peticion A bloquea la
     * nota 7 y despues la 9, y la B bloquea la 9 y despues la 7, cada una
     * espera a la otra hasta que Postgres mata una de las dos. Ordenando,
     * las dos jalan en el mismo sentido.
     */
    const ids = [...new Set(d.aplicaciones.map((a) => a.nota_id))].sort((a, b) => a - b);
    for (const id of ids) await repo.candearNota(c, id);

    // Lo que ya se aplica a cada nota DENTRO de esta misma peticion. Sin
    // esto, mandar dos renglones a la misma nota pasaria las dos
    // validaciones por separado y podria pasarse del subtotal.
    const porNota = new Map<number, number>();
    let total = 0;

    for (const a of d.aplicaciones) {
      const nota = await repo.notaParaPago(c, a.nota_id);
      if (!nota) {
        throw new ErrorValidacion(`La nota ${a.nota_id} no existe`, [
          { campo: 'aplicaciones', problema: `La nota ${a.nota_id} no existe` },
        ]);
      }

      // 409 y no 422: la nota esta en un estado, no en uno invalido. Es la
      // misma familia que NOTA_CONGELADA al editar una nota pagada.
      if (nota.estatus === 'cancelada') {
        throw new Conflicto(
          'NOTA_CANCELADA_NO_SE_COBRA',
          `La nota ${nota.folio} esta cancelada y no se le puede aplicar un pago`,
          { nota_id: nota.id, folio: nota.folio },
        );
      }

      if (nota.cliente_id !== d.cliente_id) {
        throw new ReglaNegocio(
          'NOTA_DE_OTRO_CLIENTE',
          `La nota ${nota.folio} es de otro cliente y no se puede cobrar con este pago`,
          { nota_id: nota.id, folio: nota.folio },
        );
      }

      const yaAplicado =
        centavos(await repo.montoAplicadoEnNota(c, nota.id)) + (porNota.get(nota.id) ?? 0);
      const disponible = centavos(nota.subtotal) - yaAplicado;
      const pedido = centavos(a.monto);

      if (disponible <= 0) {
        throw new Conflicto('NOTA_YA_COBRADA', `La nota ${nota.folio} ya esta pagada`, {
          nota_id: nota.id,
          folio: nota.folio,
        });
      }

      if (pedido > disponible) {
        throw new ReglaNegocio(
          'MONTO_MAYOR_A_NOTA',
          `La nota ${nota.folio} solo tiene ${(disponible / 100).toFixed(2)} por cubrir`,
          {
            nota_id: nota.id,
            folio: nota.folio,
            disponible: disponible / 100,
            solicitado: pedido / 100,
          },
        );
      }

      porNota.set(nota.id, (porNota.get(nota.id) ?? 0) + pedido);
      total += pedido;
    }

    if (total > centavos(d.monto)) {
      throw new ReglaNegocio(
        'EL_PAGO_NO_ALCANZA',
        `Las notas suman ${(total / 100).toFixed(2)} y el pago es de ${(centavos(d.monto) / 100).toFixed(2)}`,
        { monto: Number(d.monto), solicitado: total / 100 },
      );
    }

    const pagoId = await repo.insertarPago(c, { ...d, fecha });

    for (const a of d.aplicaciones) {
      await repo.insertarAplicacion(c, pagoId, a.nota_id, a.monto);
    }

    /**
     * El pago es dinero que entra a la caja: se anota tambien como
     * movimiento de la cuenta que corresponda al metodo, para que el corte y
     * el saldo de la cuenta reflejen el cobro. Sin esto, una venta pagada
     * deja rastro en cartera pero no en caja, y el corte sale en ceros.
     *
     * La cuenta es la que pidio quien cobra (`cuenta_id`). Si no se pidio
     * ninguna, se usa la primera del tipo, que es lo de siempre. Lo que
     * NO se puede es que el dinero entre siempre a la misma sin que nadie
     * lo decida: con dos cajas, el corte de una sale mal sin que nadie se
     * entere de que hubo eleccion, porque no la hubo.
     */
    const tipoCuenta =
      d.metodo === 'Transferencia' || d.metodo === 'Depósito' ? 'banco' : 'efectivo';
    const cuenta = await elegirCuenta(c, d.cuenta_id, tipoCuenta);
    if (cuenta) {
      await cajaRepo.candearCuenta(c, cuenta.id);
      await cajaRepo.crearMovimiento(c, {
        cuenta_id: cuenta.id,
        fecha,
        tipo: 'ingreso',
        categoria: 'Cobro de nota',
        monto: d.monto,
        cliente_id: d.cliente_id,
        proveedor_id: null,
        descripcion: `Pago ${pagoId}`,
        tiene_factura: d.requiere_factura ?? false,
        /**
         * El vinculo con el cobro de la cartera.
         *
         * El mismo cobro queda anotado en DOS tablas: en `pagos` (lo que
         * el cliente debe) y en `movimientos_financieros` (de donde salio
         * el dinero). Sin este vinculo no habia forma de cruzarlos, y un
         * cobro anotado dos veces en la caja se comia el saldo de una
         * cuenta sin que nadie lo notara.
         *
         * El indice unico de la migracion 0024 hace que un cobro no
         * pueda tener dos movimientos de caja.
         */
        pago_id: pagoId,
      });
    }

    return leer(c, pagoId);
  });
}

/**
 * La cuenta que recibe el dinero.
 *
 * Si se pidio una, esa es: se comprueba que exista y que su tipo sea el
 * que corresponde al metodo del pago (un efectivo no entra a un banco).
 * Si no se pidio ninguna, se usa la primera del tipo, como antes.
 */
async function elegirCuenta(
  c: PoolClient,
  cuentaId: number | undefined,
  tipo: 'efectivo' | 'banco',
): Promise<{ id: number } | null> {
  if (cuentaId !== undefined) {
    const cuenta = await cajaRepo.consultarCuenta(c, cuentaId);
    if (!cuenta) {
      throw new ErrorValidacion(`La cuenta ${cuentaId} no existe`, {
        campo: 'cuenta_id',
        problema: 'Esa cuenta de caja no existe',
      });
    }
    if (cuenta.tipo !== tipo) {
      throw new ErrorValidacion(
        `La cuenta ${cuentaId} es de tipo ${cuenta.tipo} y el pago es de tipo ${tipo}`,
        {
          campo: 'cuenta_id',
          problema: `Esa cuenta no es del tipo que corresponde al metodo del pago`,
        },
      );
    }
    return cuenta;
  }

  let cuentas = await cajaRepo.listarCuentas(c, { tipo });
  if (cuentas.length === 0) {
    cuentas = await cajaRepo.listarCuentas(c, {});
  }
  return cuentas[0] ?? null;
}

/**
 * Se relee del final de la transaccion, no se arma con lo que se mando.
 *
 * Asi el estatus de cada nota es el que escribio
 * `fn_actualizar_estatus_por_aplicaciones` y no un 'pagada' supuesto, que
 * es lo que pasaria si el servicio lo pusiera por su cuenta: con un pago
 * parcial la respuesta diria 'pagada' y el operador creeria que la nota esta
 * liquidada.
 */
async function leer(cliente: PoolClient, id: number): Promise<Pago> {
  const fila = await repo.consultarPago(cliente, id);
  if (!fila) throw new NoEncontrado('Ese pago no existe');
  const aplicaciones: AplicacionPago[] = (await repo.listarAplicaciones(cliente, id)).map(
    mapearAplicacion,
  );
  return mapearPago(fila, aplicaciones);
}
