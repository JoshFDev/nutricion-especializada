import { z } from 'zod';

/**
 * Esquemas de productos.
 *
 * Lo unico realmente delicado aqui es `presentacion_kg`, y por eso va con
 * tanto comentario: ver su definicion.
 */

/**
 * Caracteres de control: los que no se ven pero se arrastran al imprimir,
 * y que rompen el acomodo de una tabla en pantalla. Mismo criterio que el
 * modulo de catalogo: recorrido y no /[\x00-\x1f]/, porque la regla
 * no-control-regex de ESLint marca esa forma y aqui es intencional.
 */
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
 * El codigo corto con el que se maneja el producto en la bodega: 'LAC',
 * 'MBE', 'MTO'. Se recorta porque el espacio de mas viene siempre de
 * pegarlo de otro lado.
 *
 * El rango va de 1 a 40 y no de 2 en adelante como los nombres del
 * catalogo: aqui hay codigos legitimos de un solo caracter, y un minimo
 * inventado aqui terminaria rechazando datos validos del negocio.
 *
 * NO se pasa a mayusculas. El codigo es un identificador, no texto de
 * pantalla, y lo que impide que 'LAC' y 'lac' convivan es el indice
 * ux_productos_codigo_ci de la migracion 0005, no una normalizacion
 * silenciosa que dejaria al usuario preguntandose por que su codigo
 * cambio solo.
 */
const codigoProducto = sinControl('El codigo')
  .trim()
  .min(1, 'El codigo no puede quedar vacio')
  .max(40, 'El codigo no puede pasar de 40 caracteres');

/** El nombre comercial, que es lo que se ve en listas, facturas y etiquetas. */
const nombreProducto = sinControl('El nombre')
  .trim()
  .min(2, 'El nombre necesita al menos 2 caracteres')
  .max(100, 'El nombre no puede pasar de 100 caracteres');

/**
 * Kilos por bulto. NUMERIC(10,3): hasta 7 enteros y 3 decimales.
 *
 * Esto NO se valida con z.number().multipleOf(0.001) aunque parece lo
 * obvious, por dos razones:
 *
 * 1. multipleOf trabaja sobre el double, y los dobles no tienen decimales.
 *    0.1 + 0.2 da 0.30000000000000004, y un numero que se ve perfecto
 *    pasaria el multipleOf(0.001) o fallaria segun en que lado del redondeo caiga.
 *    El limite de 3 decimales se decide sobre el TEXTO, que es exacto.
 *
 * 2. A Postgres se le manda el string, no el number. Si se mandara el
 *    double, pg lo serializa y en algun momento apareceria un
 *    0.30000000000000004 guardado como 0.300.
 *
 * Se acepta number ademas de string porque un JSON bien armado puede
 * traer `20` (numero) o `"20"` (string) segun quien arme el cliente, y
 * diferenciar eso es un 400 que no le sirve de nada a nadie.
 *
 * El `> 0` tambien esta en la base (chk_productos_presentacion_positiva,
 * migracion 0005), pero se avisa aqui para que el mensaje sea uno que se
 * entienda y no el genérico de violacion de constraint.
 */
const presentacionKg = z
  .union([z.string(), z.number()], {
    error: 'La presentacion tiene que ir en kilos',
  })
  .transform((valor) => (typeof valor === 'number' ? String(valor) : valor.trim()))
  .refine((valor) => /^\d{1,7}(\.\d{1,3})?$/.test(valor), {
    message: 'La presentacion debe ser un numero positivo con hasta 3 decimales',
  })
  .refine((valor) => Number(valor) > 0, {
    message: 'La presentacion tiene que ser mayor que cero',
  });

/**
 * `productos.id` es BIGINT. El tope de Number.MAX_SAFE_INTEGER no es
 * paranoia de JavaScript: sin el, un id de 10^20 pasa el `.int()` de Zod
 * (que solo pregunta si es entero) y llega a Postgres ya redondeado, y
 * el UPDATE pega en la fila equivocada o en ninguna sin que se note.
 */
export const idProductoEsquema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive('El id debe ser un numero positivo')
    .max(Number.MAX_SAFE_INTEGER, 'Ese id esta fuera de rango'),
});

/**
 * Catalogo al que apunta el producto. SMALLINT, asi que el mismo tope de
 * 32767 que en el modulo de catalogo: si no, un 999999 revienta en
 * Postgres con 22003 en vez de contestar un 400 que explique.
 */
const idCatalogo = (campo: string) =>
  z.coerce
    .number()
    .int()
    .positive()
    .max(32767, `${campo} esta fuera de rango: el catalogo usa numeros pequenos`)
    .nullable();

export const crearProductoEsquema = z.strictObject({
  codigo: codigoProducto,
  nombre: nombreProducto,
  presentacion_kg: presentacionKg,
  categoria_id: idCatalogo('La categoria').optional().default(null),
  especie_id: idCatalogo('La especie').optional().default(null),
});

export type CrearProducto = z.infer<typeof crearProductoEsquema>;

/**
 * El PATCH es PARCIAL: se manda lo que cambia y lo demas se queda.
 *
 * Se eligio PATCH y no PUT a proposito. Un producto tiene siete campos y
 * un formulario de edicion manda tres o cuatro; con PUT de reemplazo
 * completo habria que reenviar el nombre y el codigo en cada cambio de
 * precio, y el que se olvide de un campo lo borra de verdad. Es el mismo
 * criterio que usa `usuarios`.
 *
 * `categoria_id` y `especie_id` admiten null explicito para dejar el
 * producto sin clasificar, que es distinto de "no lo mandes".
 *
 * El refin final obliga a mandar algo: un PATCH con `{}` no es un error
 * de tipos (todos los campos son opcionales) pero si es una peticion sin
 * sentido, y contestarle 200 sin haber hecho nada confunde.
 */
export const actualizarProductoEsquema = z
  .strictObject({
    codigo: codigoProducto.optional(),
    nombre: nombreProducto.optional(),
    presentacion_kg: presentacionKg.optional(),
    categoria_id: idCatalogo('La categoria').nullable().optional(),
    especie_id: idCatalogo('La especie').nullable().optional(),
    activo: z.boolean().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'No enviaste ningun campo para actualizar',
  });

export type ActualizarProducto = z.infer<typeof actualizarProductoEsquema>;

/**
 * Filtro del listado.
 *
 * `activo` trae tres estados y no un booleano porque "solo los dados de
 * baja" y "todos" son preguntas distintas, y con un booleano la segunda
 * no se puede preguntar.
 *
 * Por omision salen SOLO los activos. Es a proposito: un producto dado de
 * baja convive con el resto en la misma lista, y el día que ese listado
 * se pinte en una venta sin filtrar, se va a ofrecer algo que ya no se
 * deberia vender. Para ver los inactivos se pregunta explicito.
 *
 * strictObject y no object: con `object`, un parametro mal escrito se
 * descarta en silencio. `?busrar=X` (con la r de mas) devolvia la lista
 * COMPLETA con un 200, y el frontendDibujando 400 productos pensando que
 * estaba filtrando. Un parametro desconocido es casi siempre un error de
 * dedo, y hay que decirlo.
 */
export const listarProductosEsquema = z.strictObject({
  limite: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  buscar: sinControl('La busqueda').trim().min(1).max(200).optional(),
  activo: z.preprocess(
    (valor) => ({ true: 'activos', false: 'inactivos' })[String(valor)] ?? valor,
    z.enum(['todos', 'activos', 'inactivos']).default('activos'),
  ),
});

export type ListarProductos = z.infer<typeof listarProductosEsquema>;
