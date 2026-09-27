import { z } from 'zod';
import { decimal, fecha, idChico, idPositivo, paginacion, texto } from '../../core/valores.js';

/**
 * Esquemas de caja y bancos.
 *
 * `saldo_actual` NO se acepta en ninguna parte: lo mantiene
 * `fn_recalcular_saldo_cuenta`, que recalcula desde cero sumando todos los
 * movimientos de la cuenta. Aceptarlo abriria la puerta a cuadrar a mano lo
 * que la base recalcula sola, y el siguiente movimiento real lo volveria a
 * pisar sin que nadie se entere.
 */

export const idCuentaEsquema = z.object({ id: idChico('cuenta_id', 'las cuentas') });
export const idMovimientoEsquema = z.object({ id: idPositivo });

export const TIPOS_CUENTA = ['efectivo', 'banco'] as const;
export const TIPOS_MOVIMIENTO = ['ingreso', 'egreso'] as const;

/**
 * Alta de cuenta.
 *
 * `banco` es obligatorio cuando el tipo es 'banco' y la base no lo exige: una
 * cuenta de banco sin nombre de banco no se distingue de otra en la lista,
 * que es justo donde se mira cuando hay que encontrar un pago. Para
 * 'efectivo' no se pide nada: una caja chica no tiene banco.
 */
export const crearCuentaEsquema = z
  .object({
    nombre: texto('El nombre', 120),
    tipo: z.enum(TIPOS_CUENTA),
    banco: texto('El banco', 120).optional().nullable(),
    titular: texto('El titular', 120).optional().nullable(),
  })
  .strict()
  .refine((v) => v.tipo !== 'banco' || (v.banco !== undefined && v.banco !== null), {
    message: 'Una cuenta de banco necesita el nombre del banco',
    path: ['banco'],
  });

/** Listado de cuentas. No tiene filtros: son pocas y se usan todas. */
export const listarCuentasEsquema = z
  .object({
    tipo: z.enum(TIPOS_CUENTA).optional(),
  })
  .strict();

/**
 * Alta de movimiento.
 *
 * `cliente_id` y `proveedor_id` no pueden venir los dos: un movimiento es de
 * uno o del otro. La base no lo prohibe (ningun CHECK lo cubre) y un ingreso
 * con los dos llenados no significa nada, asi que el 400 lo dice el servicio.
 * Los dos en NULL tambien es legitimo y es el caso comun: la renta del local
 * no es de nadie.
 */
export const crearMovimientoEsquema = z
  .object({
    cuenta_id: idChico('cuenta_id', 'las cuentas'),
    fecha: fecha('fecha').optional(),
    tipo: z.enum(TIPOS_MOVIMIENTO),
    categoria: texto('La categoria', 80, 2),
    monto: decimal(10, 2, 'monto'),
    cliente_id: idPositivo.optional().nullable(),
    proveedor_id: idPositivo.optional().nullable(),
    descripcion: texto('La descripcion', 300).optional().nullable(),
    tiene_factura: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) =>
      v.cliente_id === undefined ||
      v.cliente_id === null ||
      v.proveedor_id === undefined ||
      v.proveedor_id === null,
    {
      message: 'Un movimiento no puede ser a la vez de un cliente y de un proveedor',
      path: ['cliente_id'],
    },
  );

/** Listado. Los filtros son los de la pantalla de caja, no mas. */
export const listarMovimientosEsquema = z
  .object({
    cuenta_id: idChico('cuenta_id', 'las cuentas').optional(),
    tipo: z.enum(TIPOS_MOVIMIENTO).optional(),
    categoria: texto('La categoria', 80).optional(),
    cliente_id: idPositivo.optional(),
    proveedor_id: idPositivo.optional(),
    con_factura: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
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

/** El periodo del resumen. Sin fechas, el resumen es de toda la historia. */
export const resumenEsquema = z
  .object({
    desde: fecha('desde').optional(),
    hasta: fecha('hasta').optional(),
  })
  .strict()
  .refine((v) => v.desde === undefined || v.hasta === undefined || v.desde <= v.hasta, {
    message: 'desde no puede ser posterior a hasta',
    path: ['desde'],
  });

/** Las categorias en uso, para el desplegable. Se puede acotar a una cuenta. */
export const listarCategoriasEsquema = z
  .object({
    cuenta_id: idChico('cuenta_id', 'las cuentas').optional(),
  })
  .strict();

export type CrearCuenta = z.infer<typeof crearCuentaEsquema>;
export type ListarCuentas = z.infer<typeof listarCuentasEsquema>;
export type CrearMovimiento = z.infer<typeof crearMovimientoEsquema>;
export type ListarMovimientos = z.infer<typeof listarMovimientosEsquema>;
export type Resumen = z.infer<typeof resumenEsquema>;
