import type { PoolClient } from 'pg';
import { enTransaccionDe, hoyEnLaBase } from '../../db/transaccion.js';
import { Conflicto, ErrorValidacion, NoEncontrado, Prohibido } from '../../core/errores.js';
import { fechaComoTexto } from '../../core/valores.js';
import type { CrearFactura, ListarFacturas } from './esquemas.js';
import type { EstatusFactura, Factura, FacturaListada, Listado, NotaFacturada } from './modelo.js';
import * as repo from './repositorio.js';

/**
 * Facturacion.
 *
 * Una factura agrupa las notas de remision que se le facturan juntas a un
 * cliente. `factura_nota` es la tabla que dice cuales, y `monto_total` es lo
 * que se calcula sumando esas notas: no se acepta desde la API, porque el
 * `monto_total` es lo que el SAT ve y una diferencia entre el y la mercancia
 * que salio no aparece en ningun otro lado.
 *
 * Lo que la base ya hace y aqui no se reimplementa: los permisos
 * (`trg_permiso_facturas`, 0010), la bitacora (`trg_facturas_auditoria`, 0010)
 * y el motivo obligatorio al cancelar (`chk_facturas_motivo_cancelacion`, 0010).
 *
 * Lo que la base NO puede saber, y que sale mal si no se comprueba aqui, son
 * las cuatro reglas de mas abajo. Las tres primeras son de integridad y la
 * cuarta es de dinero:
 *
 *   1. Que las notas sean del MISMO cliente que la factura. `factura_nota` no
 *      tiene FK que ligue `factura.cliente_id` con `nota.cliente_id`, asi que
 *      `factura_nota` acepta el par sin mirar y queda una factura del cliente
 *      3 que le entrega mercancia del 7.
 *   2. Que la nota no este CANCELADA. Facturar una nota cancelada es emitir un
 *      CFDI por mercancia que no salio.
 *   3. Que la nota no este YA en otra factura activa. `factura_nota` solo
 *      impide el par repetido, no la nota repetida en dos facturas
 *      distintas: la misma venta facturada dos veces, que es el doble cobro
 *      que este modulo mas que ningun otro tiene que evitar.
 *   4. Que el estatus solo avance hacia adelante. Un `solicitada` puede pasar
 *      a `emitida` y luego a `cancelada`; de ahi no sale. Volver a `emitida`
 *      una factura cancelada es un CFDI revivido, y eso no se hace desde aqui:
 *      se cancela y se pide una nueva.
 */

/** El unico camino de estatus que existe. */
const TRANSICIONES: Record<EstatusFactura, EstatusFactura[]> = {
  solicitada: ['emitida', 'cancelada'],
  emitida: ['cancelada'],
  cancelada: [],
};

export async function listar(
  cliente: PoolClient,
  q: ListarFacturas,
): Promise<Listado<FacturaListada>> {
  return repo.listar(cliente, q);
}

export async function consultar(cliente: PoolClient, id: number): Promise<Factura> {
  const fila = await repo.consultarFactura(cliente, id);
  if (!fila) throw new NoEncontrado(`No existe la factura ${id}`);
  return mapear(fila, await repo.listarNotas(cliente, id));
}

export async function crear(cliente: PoolClient, d: CrearFactura): Promise<Factura> {
  return enTransaccionDe(cliente, async (c) => {
    if (!(await repo.clienteExiste(c, d.cliente_id))) {
      throw new ErrorValidacion(`El cliente ${d.cliente_id} no existe`, [
        { campo: 'cliente_id', problema: `El cliente ${d.cliente_id} no existe` },
      ]);
    }

    // Sin duplicados: mandar la misma nota dos veces en el mismo POST es
    // casi siempre un doble clic, y sin esto el `monto_total` la contaria
    // dos veces. La base no lo prohibe: la clave de `factura_nota` es el par
    // (factura_id, nota_id) y la factura todavia no existe.
    const notas = [...new Set(d.notas)].sort((a, b) => a - b);

    /** Lo que se lleva cada nota DENTRO de esta misma peticion. */
    let total = 0;

    for (const notaId of notas) {
      const nota = await repo.notaParaFactura(c, notaId);
      if (!nota) {
        throw new ErrorValidacion(`La nota ${notaId} no existe`, [
          { campo: 'notas', problema: `La nota ${notaId} no existe` },
        ]);
      }

      if (nota.cliente_id !== d.cliente_id) {
        throw new Conflicto(
          'NOTA_DE_OTRO_CLIENTE',
          `La nota ${nota.folio} es de otro cliente y no se puede facturar en esta factura`,
          { nota_id: nota.id, folio: nota.folio },
        );
      }

      // 409 y no 422: la nota esta en un estado, no en uno invalido. Es la
      // misma familia que NOTA_CANCELADA_NO_SE_COBRA en pagos.
      if (nota.estatus === 'cancelada') {
        throw new Conflicto(
          'NOTA_CANCELADA_NO_SE_FACTURA',
          `La nota ${nota.folio} esta cancelada y no se puede facturar`,
          { nota_id: nota.id, folio: nota.folio },
        );
      }

      const yaFacturada = await repo.facturaActivaDeNota(c, notaId);
      if (yaFacturada) {
        throw new Conflicto(
          'NOTA_YA_FACTURADA',
          `La nota ${nota.folio} ya esta en la factura ${yaFacturada.id} (${yaFacturada.estatus})`,
          { nota_id: nota.id, folio: nota.folio, factura_id: yaFacturada.id },
        );
      }

      // El subtotal es NUMERIC(12,2) y ya viene redondeado de la base, asi que
      // sumar en centavos y redondear al final no cambia el resultado. Se hace
      // igual por si alguna vez se suman montos que no traigan dos decimales.
      total = Math.round((total + nota.subtotal) * 100) / 100;
    }

    const fecha = d.fecha ?? (await hoyEnLaBase(c));
    const facturaId = await repo.insertarFactura(c, {
      ...d,
      fecha,
      monto_total: total.toFixed(2),
    });

    for (const notaId of notas) {
      await repo.insertarNota(c, facturaId, notaId);
    }

    // Se relee del final de la transaccion, no se arma con lo que se mando.
    const fila = await repo.consultarFactura(c, facturaId);
    if (!fila) throw new Error('El INSERT de factura no devolvio fila');
    return mapear(fila, await repo.listarNotas(c, facturaId));
  });
}

/**
 * Mueve la factura de estatus.
 *
 * No hay PATCH: el unico campo que se puede cambiar es el estatus, y el
 * `motivo_cancelacion` lo pone el mismo UPDATE cuando va a `cancelada`. Abrir
 * un PATCH para dos transiciones fijas seria dejar que el frontend escriba la
 * maquina de estados, que es justo lo que no debe pasar.
 */
export async function cambiarEstatus(
  cliente: PoolClient,
  id: number,
  estatus: EstatusFactura,
  motivo?: string | null,
): Promise<Factura> {
  return enTransaccionDe(cliente, async (c) => {
    const fila = await repo.consultarFactura(c, id);
    if (!fila) throw new NoEncontrado(`No existe la factura ${id}`);

    if (!TRANSICIONES[fila.estatus].includes(estatus)) {
      throw new Conflicto(
        'TRANSICION_NO_PERMITIDA',
        `Una factura ${fila.estatus} no puede pasar a ${estatus}`,
        { factura_id: id, desde: fila.estatus, hacia: estatus },
      );
    }

    // El permiso lo revisa el trigger de 0010 con `facturas.solicitar`, que
    // alcanza para INSERT y para UPDATE. Emitir el CFDI y cancelar una
    // factura emitida son los dos actos que la Cajera no debe poder hacer por
    // su cuenta, asi que aqui se piden `facturas.emitir` ademas. La razon de
    // que se compruebe en el servicio y no en el trigger es que el trigger
    // solo puede exigir un permiso por operacion, y estas dos transiciones
    // son un UPDATE.
    if (estatus !== 'solicitada' && !(await tienePermisoEmitir(c))) {
      throw new Prohibido('Tu rol no tiene el permiso facturas.emitir');
    }

    if (estatus === 'cancelada' && (motivo === undefined || motivo === null || motivo === '')) {
      throw new ErrorValidacion('Cancelar una factura pide el motivo', [
        { campo: 'motivo', problema: 'El motivo es obligatorio para cancelar una factura' },
      ]);
    }

    await repo.actualizarEstatus(c, id, estatus, motivo ?? null);

    const actualizada = await repo.consultarFactura(c, id);
    if (!actualizada) throw new Error('El UPDATE de factura no devolvio fila');
    return mapear(actualizada, await repo.listarNotas(c, id));
  });
}

const tienePermisoEmitir = async (cliente: PoolClient): Promise<boolean> => {
  const { rows } = await cliente.query<{ ok: boolean }>(
    `SELECT fn_tiene_permiso('facturas.emitir') AS ok`,
  );
  return rows[0]?.ok === true;
};

const mapear = (
  f: {
    id: string;
    cliente_id: string;
    cliente_nombre: string;
    fecha: Date | string;
    metodo_pago: string | null;
    monto_total: string;
    estatus: EstatusFactura;
    motivo_cancelacion: string | null;
    creado_en: Date;
  },
  notas: NotaFacturada[],
): Factura => ({
  id: Number(f.id),
  cliente_id: Number(f.cliente_id),
  cliente: f.cliente_nombre,
  fecha: fechaComoTexto(f.fecha),
  metodo_pago: f.metodo_pago,
  monto_total: Number(f.monto_total),
  estatus: f.estatus,
  motivo_cancelacion: f.motivo_cancelacion,
  creado_en: f.creado_en.toISOString(),
  notas,
});
