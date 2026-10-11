import { z } from 'zod';
import { idAlmacen, idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas de reportes.
 *
 * Los tres son de consulta, todos con paginacion y todos `.strict()`: un
 * parametro de mas es un 400 y no un filtro que se ignora en silencio, que es
 * la misma regla que sigue el resto del proyecto.
 *
 * La busqueda es por TEXTO porque es como se pregunta en el mostrador: "el
 * reporte de LAC" o "el estado de cuenta de Juan", no "el id 47". Los ids se
 * aceptan como filtro fino (el mismo cliente que se abrio en otra pantalla),
 * pero no son obligatorios para usar el reporte.
 */

/**
 * Una bandera que llega como texto por la URL.
 *
 * `z.coerce.boolean()` no sirve aqui: convierte CUALQUIER cadena no vacia en
 * `true`, asi que `?solo_con_existencia=false` saldria verdadero, que es lo
 * contrario de lo que se pidio. Con el `enum` solo entran las dos palabras que
 * el frontend manda, y cualquier otra cosa es un 400.
 */
const bandera = z
  .enum(['true', 'false'])
  .optional()
  .transform((valor) => valor === 'true');

export const reporteExistenciaEsquema = z
  .object({
    almacen_id: idAlmacen.optional(),
    buscar: texto('La busqueda', 120).optional(),
    solo_con_existencia: bandera,
    ...paginacion,
  })
  .strict();

export const reporteConsumoEsquema = z
  .object({
    cliente_id: idPositivo.optional(),
    producto_id: idPositivo.optional(),
    buscar: texto('La busqueda', 120).optional(),
    ...paginacion,
  })
  .strict();

export const reporteEstadoCuentaEsquema = z
  .object({
    buscar: texto('La busqueda', 120).optional(),
    solo_con_saldo: bandera,
    ...paginacion,
  })
  .strict();

export type ReporteExistencia = z.infer<typeof reporteExistenciaEsquema>;
export type ReporteConsumo = z.infer<typeof reporteConsumoEsquema>;
export type ReporteEstadoCuenta = z.infer<typeof reporteEstadoCuentaEsquema>;
