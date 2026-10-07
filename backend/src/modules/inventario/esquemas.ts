import { z } from 'zod';
import { decimal, idAlmacen, idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas de inventario.
 *
 * La EXISTENCIA es de solo lectura, pero los MOVIMIENTOS no: ajustar y
 * registrar merma (`inventario.ajustar`) es justo lo que este modulo no
 * tenia. El motivo es obligatorio, la base lo exige (el `CHECK`
 * `chk_motivo_requerido` de 0001) y el registro completo queda en
 * `auditoria_inventario`, con la existencia antes y despues, por trigger.
 */

/** Los tipos que NUNCA entran por la API: los escribe la base al comprar o vender. */
const TIPOS_AUTOMATICOS = ['entrada_compra', 'salida_venta'] as const;

/** Los que SI se capturan a mano, y son los unicos que acepta el alta. */
export const TIPOS_MANUALES = ['ajuste_positivo', 'ajuste_negativo', 'merma'] as const;

/** Todos, para el historial: el kardex muestra tambien lo que hizo una compra. */
export const TIPOS_MOVIMIENTO = [...TIPOS_AUTOMATICOS, ...TIPOS_MANUALES] as const;

export const idMovimientoEsquema = z.object({ id: idPositivo });

export const listarExistenciaEsquema = z
  .object({
    producto_id: idPositivo.optional(),
    almacen_id: idAlmacen.optional(),
    /** Solo lo que hay: sirve para "dame los productos agotados". */
    vacios: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    buscar: texto('La busqueda', 120).optional(),
    ...paginacion,
  })
  .strict();

export type ListarExistencia = z.infer<typeof listarExistenciaEsquema>;

/**
 * El historial de movimientos de un producto en un almacen.
 *
 * Todos los filtros son opcionales, pero esta pantalla SIEMPRE manda al
 * menos `producto_id` y `almacen_id`: es el kardex de la combinacion que el
 * operador esta viendo. Sin filtros seria el inventario completo, que para
 * eso esta la existencia.
 */
export const listarMovimientosEsquema = z
  .object({
    producto_id: idPositivo.optional(),
    almacen_id: idAlmacen.optional(),
    tipo: z.enum(TIPOS_MOVIMIENTO).optional(),
    ...paginacion,
  })
  .strict();

export type ListarMovimientos = z.infer<typeof listarMovimientosEsquema>;

/**
 * Alta de un movimiento manual.
 *
 * `cantidad_bultos` siempre es POSITIVA: el signo lo lleva el `tipo`. El
 * `motivo` es obligatorio, como exige la base, y con minimo real de tres
 * caracteres para que "x" no pase por justificacion. No se acepta `fecha`: el
 * dia y la hora los pone la base, porque un movimiento de inventario que se
 * feche ayer es como cuadrar a mano, y ahi es donde se ocultan los errores.
 */
export const crearMovimientoEsquema = z
  .object({
    producto_id: idPositivo,
    almacen_id: idAlmacen,
    tipo: z.enum(TIPOS_MANUALES),
    cantidad_bultos: decimal(10, 2, 'cantidad_bultos'),
    motivo: texto('El motivo', 500, 3),
  })
  .strict();

export type CrearMovimiento = z.infer<typeof crearMovimientoEsquema>;
