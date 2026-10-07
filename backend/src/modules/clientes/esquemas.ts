import { z } from 'zod';

/**
 * Contrato de entrada de clientes. Es la unica fuente de verdad de "que
 * es un cliente valido": lo usan el middleware de validacion, y de aqui
 * salen los tipos de TypeScript con z.infer, para que el esquema y el
 * tipo no puedan quedar desincronizados.
 *
 * OJO: los nombres de columna vienen de la tabla `clientes` de
 * db/migrations/0001_init.sql. No hay email ni limite_credito: el estatus
 * es texto ('Activo'/'Inactivo') y el saldo lo mantiene un trigger, por
 * eso no aparece en el esquema de creacion.
 *
 * El RFC es la excepcion: TAMPOCO es columna de `clientes`, vive en
 * `datos_fiscales_cliente`, pero si entra por aqui porque es lo que la
 * pantalla captura. Escribe en esa tabla `clientes/servicio.ts`, no este
 * esquema: aqui solo se decide que es un RFC valido.
 */

export const estatusCliente = z.enum(['Activo', 'Inactivo']);

/**
 * La MISMA expresion que el `RFC` de `usuarios/esquemas.ts`.
 *
 * Copiada a proposito y no importada: los dos modulos validan el mismo
 * dato con la misma regla, y lo que no se acepta es que las dos puedan
 * quedarse distintas. Si cambia una, cambia la otra.
 */
const RFC = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

/**
 * El RFC, opcional y en blanco = sin dato.
 *
 * Va en este orden (y no `string().regex()` a secas) por dos motivos: el
 * vacio es "no tiene RFC" y no un error, y el de arriba teclea en
 * minusculas, asi que se pone en mayusculas ANTES de validar para que lo
 * que se ve en el campo sea exactamente lo que se guarda.
 */
const rfcCliente = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v.toUpperCase()))
  .refine((v) => v === null || RFC.test(v), {
    message: 'El RFC no cumple el formato del SAT (12 o 13 caracteres)',
  })
  .nullish()
  .transform((v) => v ?? null);

const codigoCliente = z
  .string()
  .trim()
  .min(1, 'El codigo de cliente es obligatorio')
  .max(40, 'El codigo no puede pasar de 40 caracteres')
  .transform((v) => v.toUpperCase());

const textoOpcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v));

export const crearClienteEsquema = z.object({
  codigo_cliente: codigoCliente,
  nombre: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  establo: textoOpcional(200),
  especie_id: z.coerce.number().int().positive().nullish(),
  estatus: estatusCliente.default('Activo'),
  telefono: textoOpcional(40),
  direccion: textoOpcional(400),
  rfc: rfcCliente,
});

/**
 * Para PATCH. Todo opcional, pero el objeto tiene que tener al menos un
 * campo: un PATCH vacio casi siempre es un bug del cliente, no una
 * peticion legitima.
 *
 * Con el RFC hay que saber distinguir dos cosas: la AUSENCIA de la clave
 * ("no vengo a tocar el rfc") y el `null` ("quitalo"). Quien manda todos
 * los campos, como el editor de la pantalla, siempre manda la clave: si
 * esta vacia va `null` y el RFC se borra.
 */
export const actualizarClienteEsquema = crearClienteEsquema
  .partial()
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'No enviaste ningun campo para actualizar',
  });

/**
 * Coercion de query params: siempre llegan como texto, y zod no los
 * convierte solo. limite/offset tienen tope para que nadie pida la tabla
 * entera de un jalon.
 */
const paginacion = z.object({
  limite: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listarClientesEsquema = paginacion.extend({
  buscar: z.string().trim().min(1).max(200).optional(),
  estatus: estatusCliente.optional(),
});

export const idClienteEsquema = z.object({
  id: z.coerce.number().int().positive('El id debe ser un numero positivo'),
});

export type CrearCliente = z.infer<typeof crearClienteEsquema>;
export type ActualizarCliente = z.infer<typeof actualizarClienteEsquema>;
export type ListarClientes = z.infer<typeof listarClientesEsquema>;
