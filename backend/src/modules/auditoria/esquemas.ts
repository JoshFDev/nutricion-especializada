import { z } from 'zod';
import { fecha, idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas de auditoria.
 *
 * Este modulo NO tiene esquemas de alta, edicion ni borrado, y no es una
 * omision: la bitacora se escribe sola por trigger. Aceptar un endpoint que
 * la escriba daria al usuario la forma de fabricar su propio rastro, que es
 * lo unico que una bitacora no puede permitir.
 *
 * El rango se pide como fecha (`AAAA-MM-DD`) aunque las columnas sean
 * TIMESTAMP, y el repositorio lo convierte a un fin de dia EXCLUSIVO
 * (`< fecha + 1`). La razon esta en `repositorio.ts` y es corta: comparar un
 * TIMESTAMP con `<= '2026-06-01'` solo cae dentro de ese dia si el valor tiene
 * hora 00:00:00, o sea que el dia final desapareceria del reporte. Un filtro
 * de rango que esconde el dia final es la forma mas facil de que un reporte
 * de caja salga mal sin que nadie lo note.
 */

/** El rango, compartido por las cinco bitacoras. */
const rango = {
  desde: fecha('desde').optional(),
  hasta: fecha('hasta').optional(),
};

const mensajeRango = {
  message: 'desde no puede ser posterior a hasta',
  path: ['desde'],
};

/**
 * `desde <= hasta` se compara como TEXTO y no con Date, y asi en las cinco
 * bitacoras. Con el formato `AAAA-MM-DD` el orden lexicografico es el mismo
 * que el cronologico, asi que el string se compara bien; y en una zona
 * horaria el `new Date('2026-06-01')` se interpretaria en UTC y
 * `desplazaria` el limite un dia.
 */
const rangoCoherente = (v: { desde?: string | undefined; hasta?: string | undefined }) =>
  v.desde === undefined || v.hasta === undefined || v.desde <= v.hasta;

export const listarLogEsquema = z
  .object({
    tabla: texto('La tabla', 60).optional(),
    operacion: z.enum(['INSERT', 'UPDATE', 'DELETE']).optional(),
    registro_id: idPositivo.optional(),
    usuario_id: idPositivo.optional(),
    buscar: texto('La busqueda', 120).optional(),
    ...rango,
    ...paginacion,
  })
  .strict()
  .refine(rangoCoherente, mensajeRango);

export const listarAccesosEsquema = z
  .object({
    evento: z
      .enum([
        'login_exitoso',
        'login_fallido',
        'logout',
        'acceso_denegado',
        'cambio_contrasena',
        'bloqueo',
        'desbloqueo',
        'usuario_creado',
        'usuario_desactivado',
      ])
      .optional(),
    usuario_id: idPositivo.optional(),
    buscar: texto('La busqueda', 120).optional(),
    ...rango,
    ...paginacion,
  })
  .strict()
  .refine(rangoCoherente, mensajeRango);

export const listarAuditoriaCajaEsquema = z
  .object({
    // `cuentas_financieras.id` es SMALLINT, asi que el tope es 32767.
    cuenta_id: z.coerce.number().int().positive().max(32767).optional(),
    usuario_id: idPositivo.optional(),
    tipo: z.enum(['ingreso', 'egreso']).optional(),
    ...rango,
    ...paginacion,
  })
  .strict()
  .refine(rangoCoherente, mensajeRango);

export const listarAuditoriaInventarioEsquema = z
  .object({
    producto_id: idPositivo.optional(),
    almacen_id: z.coerce.number().int().positive().max(32767).optional(),
    usuario_id: idPositivo.optional(),
    ...rango,
    ...paginacion,
  })
  .strict()
  .refine(rangoCoherente, mensajeRango);

export const listarAuditoriaPreciosEsquema = z
  .object({
    producto_id: idPositivo.optional(),
    cliente_id: idPositivo.optional(),
    usuario_id: idPositivo.optional(),
    tipo_precio: z.enum(['cliente', 'publico', 'costo']).optional(),
    ...rango,
    ...paginacion,
  })
  .strict()
  .refine(rangoCoherente, mensajeRango);

export type ListarLog = z.infer<typeof listarLogEsquema>;
export type ListarAccesos = z.infer<typeof listarAccesosEsquema>;
export type ListarAuditoriaCaja = z.infer<typeof listarAuditoriaCajaEsquema>;
export type ListarAuditoriaInventario = z.infer<typeof listarAuditoriaInventarioEsquema>;
export type ListarAuditoriaPrecios = z.infer<typeof listarAuditoriaPreciosEsquema>;
