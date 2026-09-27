import { z } from 'zod';
import { idAlmacen, idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas de inventario.
 *
 * Es un modulo de SOLO LECTURA. Ajustar y registrar merma (`inventario.ajustar`
 * e `inventario.merma`) son operaciones que necesitan motivo y van en la
 * bitacora de `auditoria_inventario`, asi que no se exponen aqui: dejarlas
 * fuera es mejor que exponerlas sin el motivo.
 */
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
