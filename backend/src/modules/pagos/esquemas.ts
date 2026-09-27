import { z } from 'zod';
import { decimal, fecha, idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas de pagos.
 *
 * El CHECK de la base (`metodo IN ('Efectivo','Transferencia','Depósito')`)
 * esta reescrito aqui como enum para que el 400 llegue con el nombre del
 * campo y no con el 23514 de Postgres, que no dice que campo fue.
 */
export const idPagoEsquema = z.object({ id: idPositivo });

export const METODOS_PAGO = ['Efectivo', 'Transferencia', 'Depósito'] as const;

/**
 * Un abono a una nota.
 *
 * El monto se llama `monto` en la API y `monto_aplicado` en la base: en la
 * pantalla es "esto se aplica a esta nota", no "el pago", y el nombre de la
 * columna desorientaria al operador.
 */
export const aplicacionPagoEsquema = z
  .object({
    nota_id: idPositivo,
    monto: decimal(10, 2, 'monto'),
  })
  .strict();

/**
 * Alta de pago.
 *
 * `aplicaciones` es opcional y puede venir vacia a proposito: un abono sin
 * destino (un anticipo, un pago a cuenta) es una operacion real, y el saldo
 * del cliente lo descuenta igual (`fn_recalcular_saldo_cliente` resta todos
 * los pagos, aplicados o no). Se puede aplicar despues desde la pantalla de
 * cobranza.
 *
 * Lo que NO se acepta es aplicar mas de lo recibido, o a una nota de otro
 * cliente: las dos cosas las valida el servicio y las vuelve a validar el
 * trigger `trg_validar_aplicacion_pago`.
 */
export const crearPagoEsquema = z
  .object({
    cliente_id: idPositivo,
    fecha: fecha('fecha').optional(),
    metodo: z.enum(METODOS_PAGO).nullish(),
    monto: decimal(10, 2, 'monto'),
    requiere_factura: z.boolean().default(false),
    referencia: texto('La referencia', 60).optional().nullable(),
    aplicaciones: z
      .array(aplicacionPagoEsquema)
      .max(50, 'Un pago no se reparte en mas de 50 notas')
      .default([]),
  })
  .strict();

/** Listado. Los filtros son los de una pantalla de cobranza, no mas. */
export const listarPagosEsquema = z
  .object({
    cliente_id: idPositivo.optional(),
    nota_id: idPositivo.optional(),
    metodo: z.enum(METODOS_PAGO).optional(),
    desde: fecha('desde').optional(),
    hasta: fecha('hasta').optional(),
    buscar: texto('La busqueda', 120).optional(),
    ...paginacion,
  })
  .strict()
  .refine((v) => v.desde === undefined || v.hasta === undefined || v.desde <= v.hasta, {
    message: 'desde no puede ser posterior a hasta',
    path: ['desde'],
  });

export type CrearPago = z.infer<typeof crearPagoEsquema>;
export type AplicacionPago = z.infer<typeof aplicacionPagoEsquema>;
export type ListarPagos = z.infer<typeof listarPagosEsquema>;
