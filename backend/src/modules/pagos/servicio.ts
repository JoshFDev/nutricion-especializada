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

    return leer(c, pagoId);
  });
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
