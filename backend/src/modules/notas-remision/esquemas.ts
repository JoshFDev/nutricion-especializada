import { z } from 'zod';

/**
 * Esquemas de notas de remision.
 *
 * Tres cosas de este modulo se salen de lo normal, y las tres estan
 * comentadas donde aparecen:
 *
 *   - `subtotal` NO se acepta en el cuerpo (es GENERATED en la base).
 *   - `precio_unit_kg` es opcional: si no viene, el servicio lo saca del
 *     precio vigente EN LA FECHA DE LA NOTA, no del de hoy.
 *   - `kg_bulto` tambien es opcional: `fn_default_kg_bulto` (0001) lo
 *     rellena con `productos.presentacion_kg` si llega en NULL.
 */

/** Caracteres de control. Mismo criterio que productos y precios. */
const tieneControl = (valor: string): boolean => {
  for (const caracter of valor) {
    const code = caracter.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const sinControl = (campo: string) =>
  z.string().refine((v) => !tieneControl(v), {
    message: `${campo} no puede llevar saltos de linea ni caracteres raros`,
  });

/** BIGINT. El tope de MAX_SAFE_INTEGER evita que un id de 10^20 llegue ya redondeado. */
const idPositivo = z.coerce
  .number()
  .int()
  .positive('El id debe ser un numero positivo')
  .max(Number.MAX_SAFE_INTEGER, 'Ese id esta fuera de rango');

/**
 * Fechas en texto.
 *
 * El limite de dos decimales / los multiplos de 0.01 no aplican aqui, pero
 * el problema del double SI: `new Date('2026-02-30')` no es invalido para
 * JavaScript, se normaliza al 2 de marzo sin decir nada. Un dia que no
 * existe llegaria a Postgres y Postgres lo rechazaria con un 22008 que no
 * dice que el problema es el dia. Se valida el texto antes.
 */
const FECHA_CORTADA = /^\d{4}-\d{2}-\d{2}$/;
const fecha = (campo: string) =>
  z
    .string()
    .regex(FECHA_CORTADA, `${campo} debe tener formato AAAA-MM-DD`)
    .refine((v) => {
      const partes = v.split('-').map(Number) as [number, number, number];
      const [anio, mes, dia] = partes;
      if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return false;
      const fechaUtc = new Date(Date.UTC(anio, mes - 1, dia));
      return (
        fechaUtc.getUTCFullYear() === anio &&
        fechaUtc.getUTCMonth() === mes - 1 &&
        fechaUtc.getUTCDate() === dia
      );
    }, `${campo} no es una fecha real`);

/**
 * Dinero y cantidades.
 *
 * Mismo criterio que `precio_kg` en precios: la regla de los 2 decimales se
 * decide sobre el TEXTO y a Postgres se le manda el string, no el double.
 * Con un double, pg serializa y en algun momento aparece un 3703.68
 * guardado de un 3703.6799999999996.
 *
 * `cantidad_bultos` es NUMERIC(10,2) y `kg_bulto` es NUMERIC(10,3): los
 * kilos por bulto necesitan un decimal mas porque un bulto de 25.5 kg es
 * normal y uno de 25.55 ya es raro pero cabe.
 */
const decimal = (enteros: number, decimales: number, etiqueta: string) =>
  z
    .union([z.string(), z.number()])
    .transform((valor) => String(valor).trim())
    .refine(
      (valor) => new RegExp(`^\\d{1,${enteros}}(\\.\\d{1,${decimales}})?$`).test(valor),
      `${etiqueta} debe ser un numero positivo con hasta ${decimales} decimales`,
    )
    .refine((valor) => Number(valor) > 0, `${etiqueta} no puede ser cero ni negativo`);

const precio = z
  .union([z.string(), z.number()])
  .transform((valor) => String(valor).trim())
  .refine(
    (valor) => /^\d{1,8}(\.\d{1,2})?$/.test(valor),
    'precio_unit_kg debe ser un numero con hasta 2 decimales',
  )
  .refine((valor) => Number(valor) >= 0, 'precio_unit_kg no puede ser negativo');

export const idNotaEsquema = z.object({ id: idPositivo });

/**
 * Un renglon de la nota.
 *
 * `id` es opcional porque en el alta no existe todavia, y en la edicion
 * sirve para distinguir "este renglon ya estaba" de "este es nuevo": sin
 * eso, cada guardado borraria todos los renglones y los volveria a crear,
 * y con ellos los movimientos de inventario.
 *
 * NO esta `subtotal`. Es una columna GENERATED ALWAYS
 * (`cantidad_bultos * kg_bulto * precio_unit_kg`): mandarla da 400 del
 * servidor con un mensaje en ingles sobre "cannot insert into column", que
 * no le dice al operador que el campo sobra.
 */
export const renglonNotaEsquema = z
  .object({
    id: idPositivo.optional(),
    producto_id: idPositivo,
    almacen_id: z.coerce
      .number()
      .int()
      .positive('almacen_id debe ser un numero positivo')
      .max(32767, 'almacen_id esta fuera de rango'),
    cantidad_bultos: decimal(8, 2, 'cantidad_bultos'),
    kg_bulto: decimal(7, 3, 'kg_bulto').optional(),
    precio_unit_kg: precio.optional(),
  })
  .strict();

/**
 * Alta de nota.
 *
 * `serie` en vez de `folio_id`: el numero lo elige el sistema (el mas bajo
 * disponible de esa serie) porque si el operador escribiera el numero, dos
 * personas cobrando a la vez podrian pedir el mismo y una de las dos se
 * quedaria sin nota. El talonario lo administra el admin con `notas.folios`.
 *
 * `cliente_id` y `fecha` son obligatorios porque los dos cambian el precio
 * que se cobra y el saldo que se toca. `fecha` se valida aparte para poder
 * dejar la de hoy, que es el caso normal y no deberia tener que mandarse.
 */
export const crearNotaEsquema = z
  .object({
    cliente_id: idPositivo,
    serie: sinControl('La serie')
      .min(1, 'La serie no puede ir vacia')
      .max(10, 'La serie es de 10 caracteres')
      .transform((v) => v.toUpperCase()),
    fecha: fecha('fecha').optional(),
    direccion_entrega: sinControl('La direccion de entrega')
      .max(300, 'La direccion de entrega es de 300 caracteres')
      .optional()
      .nullable(),
    renglones: z.array(renglonNotaEsquema).min(1, 'Una nota necesita al menos un renglon'),
  })
  .strict();

/**
 * Edicion.
 *
 * El estatus NO se acepta. El lo mueven los pagos (`pagos_aplicacion`) y la
 * cancelacion, que es un endpoint aparte. Aceptarlo aqui abriria la puerta
 * a marcar como pagada una nota que no esta pagada, que es exactamente lo
 * que el trigger `fn_actualizar_estatus_por_aplicaciones` evita.
 *
 * `renglones` es opcional: una correccion de la direccion no deberia
 * obligar a mandar el detalle entero. Si viene, reemplaza al conjunto
 * actual (el servicio borra los que sobran, actualiza los que cambiaron y
 * agrega los nuevos) y sigue siendo al menos uno.
 */
export const editarNotaEsquema = z
  .object({
    cliente_id: idPositivo.optional(),
    fecha: fecha('fecha').optional(),
    direccion_entrega: sinControl('La direccion de entrega')
      .max(300, 'La direccion de entrega es de 300 caracteres')
      .optional()
      .nullable(),
    renglones: z
      .array(renglonNotaEsquema)
      .min(1, 'Una nota necesita al menos un renglon')
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.cliente_id !== undefined ||
      v.fecha !== undefined ||
      v.direccion_entrega !== undefined ||
      v.renglones !== undefined,
    { message: 'No enviaste ningun campo para actualizar' },
  );

/**
 * Cancelacion.
 *
 * El motivo es obligatorio y lo hace obligatorio tambien el CHECK
 * `chk_notas_motivo_cancelacion` de 0008. Una cancelacion sin motivo es un
 * boton que borra trabajo.
 */
export const cancelarNotaEsquema = z
  .object({
    motivo: sinControl('El motivo')
      .min(3, 'El motivo es muy corto para explicar una cancelacion')
      .max(500, 'El motivo es de 500 caracteres')
      .transform((v) => v.trim()),
  })
  .strict();

/**
 * Paginacion, igual que en productos y precios: maximo 200 por pagina.
 *
 * Va como objeto aparte porque la comparten dos listados (notas y folios)
 * y duplicar los `z.coerce` dos veces en el mismo archivo es una forma de
 * que un dia uno cambie y el otro no.
 */
const paginacion = {
  limite: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

/** Listado. Los filtros son los de una pantalla de ventas, no mas. */
export const listarNotasEsquema = z
  .object({
    cliente_id: idPositivo.optional(),
    vendedor_id: idPositivo.optional(),
    estatus: z.enum(['pendiente', 'parcial', 'pagada', 'cancelada']).optional(),
    desde: fecha('desde').optional(),
    hasta: fecha('hasta').optional(),
    buscar: sinControl('La busqueda').max(120).optional(),
    ...paginacion,
  })
  .strict()
  .refine((v) => v.desde === undefined || v.hasta === undefined || v.desde <= v.hasta, {
    message: 'desde no puede ser posterior a hasta',
    path: ['desde'],
  });

/**
 * Alta del talonario.
 *
 * `desde` y `hasta` en vez de "cuantos": el admin piensa en el rango que
 * quiere tener impreso ("del 1001 al 1200"), no en un numero suelto. El
 * limite de 5000 folios por llamada evita que un `desde: 1, hasta: 9999999`
 * llene la tabla de una sentada.
 */
export const crearTalonarioEsquema = z
  .object({
    serie: sinControl('La serie')
      .min(1, 'La serie no puede ir vacia')
      .max(10, 'La serie es de 10 caracteres')
      .transform((v) => v.toUpperCase()),
    desde: z.coerce
      .number()
      .int()
      .positive('desde debe ser un numero positivo')
      .max(2_000_000_000, 'desde esta fuera de rango'),
    hasta: z.coerce
      .number()
      .int()
      .positive('hasta debe ser un numero positivo')
      .max(2_000_000_000, 'hasta esta fuera de rango'),
  })
  .strict()
  .refine((v) => v.hasta >= v.desde, {
    message: 'hasta no puede ser menor que desde',
    path: ['hasta'],
  })
  .refine((v) => v.hasta - v.desde + 1 <= 5000, {
    message: 'Un talonario de mas de 5000 folios se carga en varios trozos',
    path: ['hasta'],
  });

/** Listado del talonario, para la pantalla de administracion. */
export const listarFoliosEsquema = z
  .object({
    serie: sinControl('La serie')
      .max(10, 'La serie es de 10 caracteres')
      .transform((v) => v.toUpperCase())
      .optional(),
    estatus: z.enum(['disponible', 'usado', 'cancelado']).optional(),
    ...paginacion,
  })
  .strict();

export type CrearNota = z.infer<typeof crearNotaEsquema>;
export type EditarNota = z.infer<typeof editarNotaEsquema>;
export type RenglonNota = z.infer<typeof renglonNotaEsquema>;
export type CancelarNota = z.infer<typeof cancelarNotaEsquema>;
export type ListarNotas = z.infer<typeof listarNotasEsquema>;
export type CrearTalonario = z.infer<typeof crearTalonarioEsquema>;
export type ListarFolios = z.infer<typeof listarFoliosEsquema>;
