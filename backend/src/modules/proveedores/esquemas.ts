import { z } from 'zod';
import { idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas de proveedores.
 *
 * `saldo_actual` NO se acepta: lo mantiene `fn_recalcular_saldo_proveedor`
 * con las compras y los pagos al proveedor, y aceptarlo abriria la puerta a
 * cuadrar a mano lo que la base recalcula sola.
 *
 * `activo` si se acepta, y es la baja logica: no hay DELETE. Un proveedor
 * con historial de compras no se borra, se da de baja, porque su nombre
 * aparece en documentos viejos y borrarlos deja compras huerfanas de nombre.
 */
export const idProveedorEsquema = z.object({ id: idPositivo });

export const crearProveedorEsquema = z
  .object({
    nombre: texto('El nombre', 120),
    contacto: texto('El contacto', 120).optional().nullable(),
    telefono: texto('El telefono', 40).optional().nullable(),
  })
  .strict();

export const actualizarProveedorEsquema = z
  .object({
    nombre: texto('El nombre', 120).optional(),
    contacto: texto('El contacto', 120).optional().nullable(),
    telefono: texto('El telefono', 40).optional().nullable(),
    activo: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.nombre !== undefined ||
      v.contacto !== undefined ||
      v.telefono !== undefined ||
      v.activo !== undefined,
    { message: 'No enviaste ningun campo para actualizar' },
  );

export const listarProveedoresEsquema = z
  .object({
    activo: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    buscar: texto('La busqueda', 120).optional(),
    ...paginacion,
  })
  .strict();

export type CrearProveedor = z.infer<typeof crearProveedorEsquema>;
export type ActualizarProveedor = z.infer<typeof actualizarProveedorEsquema>;
export type ListarProveedores = z.infer<typeof listarProveedoresEsquema>;
