import { z } from 'zod';
import {
  decimal,
  fecha,
  idAlmacen,
  idPositivo,
  paginacion,
  precioKg,
  texto,
} from '../../core/valores.js';

/**
 * Esquemas de compras.
 *
 * `subtotal` NO se acepta: es GENERATED en la base
 * (`cantidad_bultos * kg_bulto * precio_kg`), igual que en notas.
 */

export const idCompraEsquema = z.object({ id: idPositivo });

/**
 * Un renglon de compra.
 *
 * `kg_bulto` es opcional porque `fn_default_kg_bulto` (0001) lo rellena con
 * `productos.presentacion_kg`. Se puede mandar cuando el proveedor vendio
 * un empaque distinto al del catalogo, y entonces la compra guarda ese, que
 * es justo para lo que existe la columna: que cambiar la presentacion del
 * producto mañana no altere el historico de esta compra.
 */
export const renglonCompraEsquema = z
  .object({
    producto_id: idPositivo,
    almacen_id: idAlmacen,
    cantidad_bultos: decimal(8, 2, 'cantidad_bultos'),
    kg_bulto: decimal(7, 3, 'kg_bulto').optional(),
    precio_kg: precioKg('precio_kg').optional(),
  })
  .strict();

/**
 * Alta de compra.
 *
 * `precio_kg` es opcional en el renglon y obligatorio en la practica: si no
 * viene, el servicio lo saca del ultimo costo vigente de ESE proveedor para
 * ese producto en la fecha de la compra (`producto_proveedor_precios`). Si
 * no hay costo registrado tampoco, es un 422: el costo hay que escribirlo
 * alguna vez, y un renglon a costo cero en silencio falsearia el margen de
 * todo el producto.
 *
 * `estatus` NO se acepta. Lo mueven los pagos al proveedor
 * (`pagos_proveedor`), que se registran con `POST /:id/pagar`: una compra
 * nueva nace 'pendiente' y ahi la dejan sus abonos. Aceptarlo aqui abriria la
 * puerta a marcar como pagada una compra que no se pago.
 */
export const crearCompraEsquema = z
  .object({
    proveedor_id: idPositivo,
    fecha: fecha('fecha').optional(),
    folio_proveedor: texto('El folio del proveedor', 60).optional().nullable(),
    renglones: z.array(renglonCompraEsquema).min(1, 'Una compra necesita al menos un renglon'),
  })
  .strict();

/**
 * Cancelacion.
 *
 * El motivo es obligatorio, y lo hace obligatorio tambien el CHECK
 * `chk_compras_motivo_cancelacion` de 0009. Cancelar una compra saca mercancia
 * de la bodega: sin un "¿por que?", lo que queda es un boton que borra
 * trabajo. Es la misma regla que la nota de remision.
 */
export const cancelarCompraEsquema = z
  .object({
    motivo: texto('El motivo', 500, 3).transform((v) => v.trim()),
  })
  .strict();

export const listarComprasEsquema = z
  .object({
    proveedor_id: idPositivo.optional(),
    estatus: z.enum(['pendiente', 'parcial', 'pagada', 'cancelada']).optional(),
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

export type CrearCompra = z.infer<typeof crearCompraEsquema>;
export type RenglonCompra = z.infer<typeof renglonCompraEsquema>;
export type CancelarCompra = z.infer<typeof cancelarCompraEsquema>;
export type ListarCompras = z.infer<typeof listarComprasEsquema>;
