import { z } from 'zod';

/**
 * Esquemas del catalogo.
 *
 * Especies y Categorias de Producto son la MISMA cosa con distinto
 * nombre: una tabla con id y nombre unico. Por eso comparten esquema en
 * vez de duplicarlo.
 */

/**
 * Caracteres de control: los que no se ven pero se carried al imprimir, y
 * que rompen el acomodo de una tabla en pantalla.
 *
 * Se revisa con un recorrido y no con /[\x00-\x1f]/ a proposito: la
 * regla no-control-regex de ESLint marca esa forma porque casi siempre
 * es un error de dedo, y aqui es intencional. Un recorrido lo dice sin
 * silenciar nada.
 */
const tieneControl = (valor: string): boolean => {
  for (const caracter of valor) {
    const code = caracter.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * El nombre de una especie o categoria.
 *
 * Se recorta y se exige un minimo de 2 porque un nombre de un caracter
 * ("A") siempre es una captura mal hecha, y en un catalogo estas filas se
 * muestran en cada combo box de venta: un texto asi sale en pantalla
 * cientos de veces al dia.
 */
const nombreCatalogo = z
  .string()
  .trim()
  .min(2, 'El nombre necesita al menos 2 caracteres')
  .max(100, 'El nombre no puede pasar de 100 caracteres')
  .refine((v) => !tieneControl(v), {
    message: 'El nombre no puede llevar saltos de linea ni caracteres raros',
  });

export const crearCatalogoEsquema = z
  .strictObject({
    nombre: nombreCatalogo,
  })
  .describe('Especies y categorias comparten el mismo cuerpo.');

export type CrearCatalogo = z.infer<typeof crearCatalogoEsquema>;

export const renombrarCatalogoEsquema = z
  .strictObject({
    nombre: nombreCatalogo,
  })
  .describe('Solo se renombra. El id nunca se cambia.');

export type RenombrarCatalogo = z.infer<typeof renombrarCatalogoEsquema>;

/**
 * `especies.id` y `categorias_producto.id` son SMALLINT, no BIGINT como
 * las tablas de negocio. Smallint llega hasta 32767.
 *
 * Sin este max, pedir /api/especies/999999 pasa la validacion de Zod,
 * llega a Postgres y revienta con 22003 (numeric_value_out_of_range), que
 * el manejador traduce a un 400 genérico sin decir por que. Con el tope
 * el 400 llega antes, con un mensaje que si explica.
 */
const MAX_ID_CATALOGO = 32767;

export const idCatalogoEsquema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_ID_CATALOGO, 'Ese id esta fuera de rango: el catalogo usa numeros pequenos'),
});
