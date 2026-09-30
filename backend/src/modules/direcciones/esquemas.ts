import { z } from 'zod';

/**
 * Esquemas del catalogo de direcciones de entrega.
 *
 * Los tres limites de aqui no son arbitrarios; cada uno esta porque hay algo
 * que se rompe si no:
 *
 *   - `sinControl`: una direccion con salto de linea se lleva el renglon de
 *     la tabla del Excel y parte la linea en dos. Es el mismo criterio que
 *     notas, clientes y productos.
 *   - 2 caracteres minimos en el nombre: el nombre es la etiqueta que se lee
 *     en el desplegable del mostrador, y un nombre de un caracter no
 *     distingue dos destinos.
 *   - 300 caracteres en la direccion: es el tope de `notas_remision
 *     .direccion_entrega` (ver `notas-remision/esquemas.ts`). Si el catalogo
 *     aceptara mas, una direccion se podria guardar aqui y todavia no
 *     escribir en la nota, y el error sale en el peor momento: con el camion
 *     esperando y la mercancia ya cargada.
 */

/** Caracteres de control. Mismo recorrido que el de catalogo y notas. */
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

/** La etiqueta corta del destino. */
export const nombreDireccionEsquema = sinControl('El nombre')
  .trim()
  .min(2, 'El nombre necesita al menos 2 caracteres')
  .max(80, 'El nombre no puede pasar de 80 caracteres');

/**
 * El texto que se imprime.
 *
 * `sinControl(...).trim()` y no `z.string().trim()`: los dos recortes se
 * necesitan, pero el de los caracteres de control tiene que ir antes del
 * `min`, porque un nombre de cinco espacios pasa el `min(2)` de otra manera
 * y llega a Postgres con un CHECK que lo rechaza con un 500 en vez de con un
 * 400 que diga que se puso un texto vacio.
 */
export const textoDireccionEsquema = sinControl('La direccion')
  .trim()
  .min(5, 'La direccion necesita al menos 5 caracteres')
  .max(300, 'La direccion no puede pasar de 300 caracteres');

/**
 * `pos.direcciones_entrega.id` es SMALLINT (migracion 0011), no BIGINT como
 * las tablas de negocio. Smallint llega hasta 32767, y sin este tope un
 * `GET /api/direcciones-entrega/999999` pasa la validacion de Zod y revienta
 * en Postgres con un 22003 que el manejador traduce a un 400 sin decir por
 * que. Mismo criterio y mismo mensaje que `idCatalogoEsquema`.
 */
export const idDireccionEsquema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive('El id debe ser un numero positivo')
    .max(32767, 'Ese id esta fuera de rango: las direcciones usan numeros pequenos'),
});

/** Alta. El cuerpo es el mismo que el de la edicion: se manda el par entero. */
export const crearDireccionEsquema = z
  .object({
    nombre: nombreDireccionEsquema,
    direccion: textoDireccionEsquema,
  })
  .strict()
  .describe('Alta y edicion comparten cuerpo: los dos textos se mandan siempre.');

export type CrearDireccion = z.infer<typeof crearDireccionEsquema>;
