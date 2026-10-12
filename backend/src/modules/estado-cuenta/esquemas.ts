import { z } from 'zod';
import { idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas del estado de cuenta.
 *
 * El listado es el mismo molde que el de reportes (busqueda por texto, el
 * filtro de "solo con saldo" y paginacion), porque es la misma pregunta: que
 * clientes debe. La diferencia es que aqui cada fila puede abrir su hoja, y
 * por eso la segunda ruta solo valida el `id` del cliente.
 *
 * Ambos son `.strict()` como el resto del proyecto: un parametro de mas es un
 * 400, no un filtro que se ignora en silencio.
 */

/**
 * Una bandera que llega como texto por la URL.
 *
 * `z.coerce.boolean()` no sirve aqui: convierte CUALQUIER cadena no vacia en
 * `true`, asi que `?solo_con_saldo=false` saldria verdadero, que es lo
 * contrario de lo que se pidio. Con el `enum` solo entran las dos palabras que
 * el frontend manda, y cualquier otra cosa es un 400.
 */
const bandera = z
  .enum(['true', 'false'])
  .optional()
  .transform((valor) => valor === 'true');

export const listarEstadoCuentaEsquema = z
  .object({
    buscar: texto('La busqueda', 120).optional(),
    solo_con_saldo: bandera,
    ...paginacion,
  })
  .strict();

/** El `:id` de la ruta de la hoja. */
export const hojaEstadoCuentaEsquema = z
  .object({ id: idPositivo, rango: z.enum(['todo', 'semana', 'mes']).optional() })
  .strict();

export const generalEstadoCuentaEsquema = z
  .object({
    cliente_ids: z
      .array(idPositivo)
      .min(1, 'Selecciona al menos un cliente')
      .max(100, 'Demasiados clientes seleccionados'),
  })
  .strict();

export type ListarEstadoCuenta = z.infer<typeof listarEstadoCuentaEsquema>;
export type HojaEstadoCuenta = z.infer<typeof hojaEstadoCuentaEsquema>;
export type GeneralEstadoCuenta = z.infer<typeof generalEstadoCuentaEsquema>;
