import { z } from 'zod';
import { fecha, idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas de facturacion.
 *
 * `monto_total` NO se acepta: lo calcula el servicio sumando el subtotal de
 * las notas que cubre. Aceptarlo abriria la puerta a facturar una nota por
 * una cantidad que no es la que se vendio, y la diferencia no apareceria en
 * ningun lado: el `monto_total` es lo que el SAT ve.
 *
 * `metodo_pago` es texto libre y NO es el enum de `pagos.metodo`. Son cosas
 * distintas: el metodo de un pago es como se recibio el dinero
 * (Efectivo/Transferencia/Deposito, con CHECK en la base desde 0001), y el de
 * una factura es la forma de pago del CFDI, que tiene sus propios codigos
 * (01, 03, 04, 28...) y no tiene sentido escribir esos codigos aqui a
 * ciegas. La base lo deja en TEXT sin CHECK y por eso la API no lo estrecha.
 */

export const idFacturaEsquema = z.object({ id: idPositivo });

export const ESTATUS_FACTURA = ['solicitada', 'emitida', 'cancelada'] as const;

/**
 * Alta de factura.
 *
 * `notas` es obligatoria y con al menos una: una factura de 0 pesos no es un
 * documento, es un borrador. Lo que la base no prohibe (el `monto_total` tiene
 * DEFAULT 0 y ningun CHECK) lo pone el servicio con un 400 que lo explica.
 */
export const crearFacturaEsquema = z
  .object({
    cliente_id: idPositivo,
    fecha: fecha('fecha').optional(),
    metodo_pago: texto('El metodo de pago', 60).optional().nullable(),
    notas: z
      .array(idPositivo)
      .min(1, 'Una factura tiene que cubrir al menos una nota')
      .max(200, 'Una factura no puede cubrir mas de 200 notas'),
  })
  .strict();

/** Listado. Los filtros son los de la pantalla de facturacion. */
export const listarFacturasEsquema = z
  .object({
    cliente_id: idPositivo.optional(),
    estatus: z.enum(ESTATUS_FACTURA).optional(),
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

/**
 * El unico "cambio" que admite una factura.
 *
 * `solicitada` esta en el enum a proposito, aunque no sea un destino valido
 * desde ningun estatus: si no esta, un PATCH con el estatus que ya tiene
 * devolveria un 400 de validacion ("estatus invalido"), que dice que el
 * cliente mando mal los datos, cuando lo que paso es que la transicion no
 * existe. El 409 TRANSICION_NO_PERMITIDA si lo dice bien.
 *
 * `motivo` solo lo usa la transaccion a 'cancelada', y el servicio lo exige
 * solo ahi. Aceptarlo en las demas no hace falta y no hace dano: se ignora.
 */
export const cambiarEstatusEsquema = z
  .object({
    estatus: z.enum(ESTATUS_FACTURA),
    motivo: texto('El motivo', 500).optional().nullable(),
  })
  .strict();

export type CrearFactura = z.infer<typeof crearFacturaEsquema>;
export type ListarFacturas = z.infer<typeof listarFacturasEsquema>;
export type CambiarEstatus = z.infer<typeof cambiarEstatusEsquema>;
