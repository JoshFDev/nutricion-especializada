import { z } from 'zod';

/**
 * Validadores que se repiten en mas de un modulo.
 *
 * Antes vivian copiados dentro de `notas-remision/esquemas.ts` y
 * `precios/esquemas.ts`. Dos copias de la validacion de una fecha son dos
 * lugares donde un dia una acepta `2026-02-30` y la otra no, y ese tipo de
 * diferencia se descubre en produccion.
 *
 * Lo que SI se queda en cada modulo es lo que es de ese modulo: el nombre
 * del campo en los mensajes (`precio_unit_kg` no es `precio_kg`) y las
 * reglas propias de cada pantalla.
 */

/** Caracteres de control: un salto de linea dentro de un nombre de cliente no es un nombre. */
const tieneControl = (valor: string): boolean => {
  for (const caracter of valor) {
    const code = caracter.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * Texto de una sola linea.
 *
 * `min` es opcional a proposito: un campo OPCIONAL se hace opcional con
 * `.optional()`, no con un `min` de 0, que ademas no rechazaria el texto
 * vacio cuando si se queria. Por eso los tres usos son distintos y
 * deliberados: `texto('La serie', 10)` (obligatorio), `texto('La
 * busqueda', 120)` (opcional, admite cadena vacia) y
 * `texto('El motivo', 500, 3)` (obligatorio y con minimo real).
 */
export const texto = (campo: string, max = 300, min?: number) => {
  const base = z.string().max(max, `${campo} es de ${max} caracteres`);
  const conMinimo =
    min === undefined
      ? base
      : base.min(min, min === 1 ? `${campo} no puede ir vacio` : `${campo} es muy corto`);
  // El refine va AL FINAL a proposito: `refine` devuelve un ZodEffects, que
  // ya no tiene `.max()` ni `.min()`. Al reves, la cadena no se podria
  // acotar despues de validarla.
  return conMinimo.refine((v) => !tieneControl(v), {
    message: `${campo} no puede llevar saltos de linea ni caracteres raros`,
  });
};

/**
 * BIGINT.
 *
 * El tope de MAX_SAFE_INTEGER evita que un id de 10^20 llegue ya redondeado:
 * mas alla de 2^53 los `number` de JavaScript dejan de distinguir un id del
 * siguiente, y un id equivocado es una nota de otro cliente.
 */
export const idPositivo = z.coerce
  .number()
  .int()
  .positive('El id debe ser un numero positivo')
  .max(Number.MAX_SAFE_INTEGER, 'Ese id esta fuera de rango');

/**
 * Fechas en texto `AAAA-MM-DD`.
 *
 * Se valida el TEXTO antes de castear, y no por purismo: para JavaScript
 * `new Date('2026-02-30')` no es invalido, se normaliza al 2 de marzo sin
 * decir nada. Ese dia llegaria a Postgres como 2026-03-02 y el operador
 * creeria que guardo el 30 de febrero. Postgres si lo rechaza, pero con un
 * 22008 que habla de rangos, no del dia que no existe.
 */
const FECHA_CORTADA = /^\d{4}-\d{2}-\d{2}$/;

export const fecha = (campo: string) =>
  z
    .string()
    .regex(FECHA_CORTADA, `${campo} debe tener formato AAAA-MM-DD`)
    .refine((v) => {
      const [anio, mes, dia] = v.split('-').map(Number) as [number, number, number];
      if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return false;
      const utc = new Date(Date.UTC(anio, mes - 1, dia));
      return (
        utc.getUTCFullYear() === anio && utc.getUTCMonth() === mes - 1 && utc.getUTCDate() === dia
      );
    }, `${campo} no es una fecha real`);

/**
 * Cantidades y montos: positivos, con sus decimales, y manipulados como
 * TEXTO de punta a punta.
 *
 * El double no sirve para dinero: `3703.68` multiplicado y acumulado termina
 * en `3703.6799999999996`, y a Postgres le llega un `numeric` con ruido. Por
 * eso `enteros`/`decimales` se deciden sobre el string y el string es lo que
 * se manda a la base.
 *
 * Siempre positivos. El cero en una cantidad no significa nada, y el `CHECK
 * (monto > 0)` de la base lo prohibe igual: mejor que el 400 lo diga el
 * servicio con el nombre del campo.
 */
export const decimal = (enteros: number, decimales: number, etiqueta: string) =>
  z
    .union([z.string(), z.number()])
    .transform((valor) => String(valor).trim())
    .refine(
      (valor) => new RegExp(`^\\d{1,${enteros}}(\\.\\d{1,${decimales}})?$`).test(valor),
      `${etiqueta} debe ser un numero positivo con hasta ${decimales} decimales`,
    )
    .refine((valor) => Number(valor) > 0, `${etiqueta} no puede ser cero ni negativo`);

/**
 * Precio por kilo: hasta 2 decimales, y el cero SI se acepta.
 *
 * Un producto de cortesia vale 0, y esa es la diferencia con `decimal`:
 * aqui el refine final es `>= 0` y no `> 0`.
 */
export const precioKg = (campo: string) =>
  z
    .union([z.string(), z.number()])
    .transform((valor) => String(valor).trim())
    .refine(
      (valor) => /^\d{1,8}(\.\d{1,2})?$/.test(valor),
      `${campo} debe ser un numero con hasta 2 decimales`,
    )
    .refine((valor) => Number(valor) >= 0, `${campo} no puede ser negativo`);

/**
 * El id de una tabla cuya clave es SMALLINT y no BIGINT: 32767 es el tope.
 *
 * Sin el `max`, un 999999 pasa la validacion de Zod, llega a Postgres y
 * revienta con 22003, que el manejador traduce a un 400 generico sin decir
 * por que. Con el tope el 400 llega antes y explica el motivo.
 *
 * Hay dos en el esquema y por eso el nombre de la tabla va como parametro en
 * vez de estar escrito dentro: el mensaje tiene que decir QUE tabla usa
 * numeros chicos, y "las cuentas usan numeros chicos" es la mitad de la
 * explicacion. `campo` por lo mismo: el mensaje se lee en la pantalla, junto
 * al campo que el operador esta llenando.
 */
export const idChico = (campo: string, tabla: string) =>
  z.coerce
    .number()
    .int()
    .positive(`${campo} debe ser un numero positivo`)
    .max(32767, `${campo} esta fuera de rango: ${tabla} usan numeros chicos`);

/** `almacenes.id` es SMALLINT. Ver `idChico`. */
export const idAlmacen = idChico('almacen_id', 'los almacenes');

/**
 * Una DATE de Postgres como texto `AAAA-MM-DD`.
 *
 * El driver entrega las DATE como `Date` a MEDIANOCHE en hora local, y por
 * eso esto lee las partes locales del `Date` en vez de llamar a
 * `toISOString()`: ese metodo convierte a UTC, y en una maquina en un huso
 * negativo devuelve el dia ANTERIOR (`2026-06-01` -> `2026-05-31T24:00`).
 * Para una vigencia o una venta, un dia corrido es un dia de diferencia.
 *
 * Se escribe a mano en vez de usar `toLocaleDateString('en-CA')` porque ese
 * depende de los datos de ICU del runtime, y en una imagen de Node
 * minimalista cambia el formato sin avisar.
 *
 * Acepta `string` tambien, porque hay validasores que dejan pasar el texto
 * tal cual (`--hasta=2026-06-01`) y ese ya viene en el formato correcto.
 */
export const fechaComoTexto = (valor: Date | string): string => {
  if (typeof valor === 'string') return valor.slice(0, 10);
  const anio = valor.getFullYear();
  const mes = String(valor.getMonth() + 1).padStart(2, '0');
  const dia = String(valor.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
};

/** Paginacion comun a todos los listados: maximo 200 por pagina. */
export const paginacion = {
  limite: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
