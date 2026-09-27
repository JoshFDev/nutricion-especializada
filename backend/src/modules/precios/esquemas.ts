import { z } from 'zod';

/**
 * Esquemas de precios.
 *
 * Hay dos cosas que se salen de lo normal en este modulo, y las dos estan
 * comentadas donde aparecen: `precio_kg` (dinero) y `vigente_hasta` (el
 * fin, que es inclusivo y no se puede dejar en el pasado).
 */

/** Caracteres de control. Mismo criterio que el modulo de productos. */
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

/**
 * `productos.id` es BIGINT y `clientes.id` tambien, asi que el tope de
 * Number.MAX_SAFE_INTEGER no es paranoia: sin el, un id de 10^20 pasa el
 * `.int()` de Zod (que solo pregunta si es entero) y llega a Postgres ya
 * redondeado, y el UPDATE pega en la fila equivocada sin que se note.
 */
export const idPrecioEsquema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive('El id debe ser un numero positivo')
    .max(Number.MAX_SAFE_INTEGER, 'Ese id esta fuera de rango'),
});

/**
 * El precio por kilo. NUMERIC(10,2): hasta 8 enteros y 2 decimales.
 *
 * Mismo criterio que `presentacion_kg` en productos, y por las mismas dos
 * razones:
 *
 * 1. No se valida con `z.number().multipleOf(0.01)`. multipleOf trabaja
 *    sobre el double, y los dobles no tienen decimales: 1234.56 * 3 da
 *    3703.6799999999996, y un numero que el usuario ve bien pasaria el
 *    multipleOf un dia y lo fallaria otro segun de que lado del redondeo
 *    caiga. El limite de 2 decimales se decide sobre el TEXTO, que es
 *    exacto.
 *
 * 2. A Postgres se le manda el string, no el number. Con el double, pg
 *    lo serializa y en algun momento aparece un 3703.68 guardado de un
 *    3703.6799999999996.
 *
 * Se acepta number ademas de string porque un JSON bien armado puede traer
 * `90` o `"90"` segun quien arme el cliente, y diferenciar eso es un 400
 * que no le sirve de nada.
 *
 * Un precio de CERO si se permite, a diferencia de la presentacion: hay
 * precios de cortesia y de producto de muestra. El >= 0 ya esta en la base
 * (el CHECK de 0001) y aqui se repite para que el mensaje sea util.
 */
const precioKg = z
  .union([z.string(), z.number()], {
    error: 'El precio tiene que ir por kilo',
  })
  .transform((valor) => (typeof valor === 'number' ? String(valor) : valor.trim()))
  .refine((valor) => /^\d{1,8}(\.\d{1,2})?$/.test(valor), {
    message: 'El precio debe ser un numero con hasta 2 decimales',
  })
  .refine((valor) => Number(valor) >= 0, {
    message: 'El precio no puede ser negativo',
  });

/**
 * `vigente_desde` y `vigente_hasta` son DATE, no TIMESTAMP.
 *
 * Se validan como texto en formato AAAA-MM-DD a proposito, y no se
 * "normalizan" con `new Date()`: el objeto Date tiene una zona horaria
 * pegada, y al volver a serializarlo un cliente en otro huso puede
 * escribir un dia distinto al que leyo. Para una fecha de vigencia el
 * texto es la forma honesta.
 *
 * `vigente_hasta` en NULL significa "abierto, aplica hasta que se cierre".
 * `vigente_hasta: null` explicito esta permitido y es lo mismo.
 */
const fechaVigencia = sinControl('La fecha')
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe ir en formato AAAA-MM-DD')
  .refine((valor) => !Number.isNaN(Date.parse(`${valor}T00:00:00Z`)), 'Esa fecha no existe')
  .refine((valor) => valor >= '1900-01-01', 'Esa fecha es Anterior a lo que el negocio documenta')
  .refine((valor) => valor <= '2999-12-31', 'Esa fecha esta demasiado lejos');

/**
 * `vigente_desde` es obligatorio en el alta y con fecha.
 *
 * Lo mandamos como string a Postgres (::date) en vez de dejar que el
 * DEFAULT CURRENT_DATE de 0001 lo ponga. La razon esta al final de la
 * migracion 0007: si el trigger comparara contra el default de Postgres,
 * un INSERT sin fechas se saltaria el control de traslape y el trigger
 * solo protegeria a quien escribiera las fechas a mano.
 */
const vigenteDesde = fechaVigencia;

/**
 * El alta de un precio publico.
 *
 * `vigente_hasta` opcional: si no viene, el precio queda abierto. Si viene,
 * el servicio comprueba que no termine antes de empezar.
 */
export const crearPrecioPublicoEsquema = z
  .strictObject({
    producto_id: z.coerce
      .number()
      .int()
      .positive('El producto_id debe ser un numero positivo')
      .max(Number.MAX_SAFE_INTEGER, 'Ese producto esta fuera de rango'),
    precio_kg: precioKg,
    vigente_desde: vigenteDesde,
    vigente_hasta: fechaVigencia.nullable().optional(),
  })
  .refine(
    (d) =>
      d.vigente_hasta === undefined ||
      d.vigente_hasta === null ||
      d.vigente_hasta >= d.vigente_desde,
    {
      message: 'La vigencia no puede terminar antes de empezar',
    },
  );

export type CrearPrecioPublico = z.infer<typeof crearPrecioPublicoEsquema>;

/** El alta de un precio especial de cliente. */
export const crearPrecioClienteEsquema = z
  .strictObject({
    cliente_id: z.coerce
      .number()
      .int()
      .positive('El cliente_id debe ser un numero positivo')
      .max(Number.MAX_SAFE_INTEGER, 'Ese cliente esta fuera de rango'),
    producto_id: z.coerce
      .number()
      .int()
      .positive('El producto_id debe ser un numero positivo')
      .max(Number.MAX_SAFE_INTEGER, 'Ese producto esta fuera de rango'),
    precio_kg: precioKg,
    vigente_desde: vigenteDesde,
    vigente_hasta: fechaVigencia.nullable().optional(),
  })
  .refine(
    (d) =>
      d.vigente_hasta === undefined ||
      d.vigente_hasta === null ||
      d.vigente_hasta >= d.vigente_desde,
    {
      message: 'La vigencia no puede terminar antes de empezar',
    },
  );

export type CrearPrecioCliente = z.infer<typeof crearPrecioClienteEsquema>;

/**
 * El PATCH es PARCIAL, igual que productos y usuarios.
 *
 * `vigente_hasta: null` se distingue de "no lo mandes" y significa abrir
 * el precio de nuevo. Es un caso raro (reabrir algo que se cerro) pero
 * si es legal en el esquema y la API no lo prohibits, entonces cada
 * cliente tendria su propia forma de reabrir, y la que no corresponda
 * fallaria con un 409 del trigger de traslape.
 */
export const actualizarPrecioPublicoEsquema = z
  .strictObject({
    precio_kg: precioKg.optional(),
    vigente_desde: vigenteDesde.optional(),
    vigente_hasta: fechaVigencia.nullable().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'No enviaste ningun campo para actualizar',
  });

export type ActualizarPrecioPublico = z.infer<typeof actualizarPrecioPublicoEsquema>;

export const actualizarPrecioClienteEsquema = z
  .strictObject({
    precio_kg: precioKg.optional(),
    vigente_desde: vigenteDesde.optional(),
    vigente_hasta: fechaVigencia.nullable().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'No enviaste ningun campo para actualizar',
  });

export type ActualizarPrecioCliente = z.infer<typeof actualizarPrecioClienteEsquema>;

/**
 * Filtro del listado de precios.
 *
 * `vigencia` trae tres estados porque "los que se aplican hoy" y "todos
 * los historicos" son preguntas distintas, y con un booleano la segunda no
 * se puede preguntar. Y de los historicos no tiene mucho sentido ver solo
 * los viejos: lo que se consulta casi siempre es "que precios tiene este
 * producto", o sea la linea de tiempo completa.
 *
 * Por omision salen los VIGENTES: un precio que ya no aplica, listado al
 * lado del que si, es exactamente el error que uno quiere evitar.
 */
const filtroVigencia = z.preprocess(
  (valor) => ({ true: 'vigentes', false: 'historicos' })[String(valor)] ?? valor,
  z.enum(['todos', 'vigentes', 'historicos']).default('vigentes'),
);

export const listarPreciosPublicosEsquema = z.strictObject({
  limite: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  producto_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  vigencia: filtroVigencia,
});

export type ListarPreciosPublicos = z.infer<typeof listarPreciosPublicosEsquema>;

export const listarPreciosClienteEsquema = z.strictObject({
  limite: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  cliente_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  producto_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  vigencia: filtroVigencia,
});

export type ListarPreciosCliente = z.infer<typeof listarPreciosClienteEsquema>;

/**
 * La consulta del precio que toca cobrar.
 *
 * `fecha` es opcional y por omision es HOY, que es lo que se quiere casi
 * siempre. Se acepta explícita para poder cotizar una entrega a futuro sin
 * tener que dar de alta un precio: el caso real es un client al que le
 * vence el especial el viernes y se lleva el viernes.
 */
export const precioEfectivoEsquema = z.strictObject({
  producto_id: z.coerce
    .number()
    .int()
    .positive('El producto_id debe ser un numero positivo')
    .max(Number.MAX_SAFE_INTEGER, 'Ese producto esta fuera de rango'),
  cliente_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  fecha: fechaVigencia.optional(),
});

export type PrecioEfectivo = z.infer<typeof precioEfectivoEsquema>;

/**
 * El cuerpo de `POST /:id/cerrar`.
 *
 * Va en un esquema propio y no se reusa el PATCH, porque este POST solo
 * puede cambiar UNA cosa: la fecha de fin. Aceptar el PATCH entero aqui
 * abriria la puerta a "cerrar" con un precio_kg distinto al que se guardo,
 * que es un cambio de precio disfrazado de un cierre — y el cerrado con
 * fecha y el cambio de numero son dos hechos que la cuenta quiere poder
 * separar al leer la linea de tiempo.
 *
 * `vigente_hasta` es obligatorio y no admite null: cerrar con null seria
 * "abrir", que es lo contrario de cerrar, y ademas reabrir un precio
 * cerrado no tiene sentido de negocio. Para abrir hay que PATCHear la
 * vigencia completa, que si va por el trigger anti-traslape.
 */
export const cerrarPrecioEsquema = z.strictObject({
  vigente_hasta: fechaVigencia,
});

export type CerrarPrecio = z.infer<typeof cerrarPrecioEsquema>;
