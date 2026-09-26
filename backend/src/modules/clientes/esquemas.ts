import { z } from 'zod';

/**
 * Contrato de entrada de clientes. Es la unica fuente de verdad de "que
 * es un cliente valido": lo usan el middleware de validacion, y de aqui
 * salen los tipos de TypeScript con z.infer, para que el esquema y el
 * tipo no puedan quedar desincronizados.
 *
 * OJO: los nombres de columna vienen de la tabla `clientes` de
 * db/migrations/0001_init.sql. No hay rfc, ni email, ni limite_credito:
 * el estatus es texto ('Activo'/'Inactivo') y el saldo lo mantiene un
 * trigger, por eso no aparece en el esquema de creacion.
 */

export const estatusCliente = z.enum(['Activo', 'Inactivo']);

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
});

/**
 * Para PATCH. Todo opcional, pero el objeto tiene que tener al menos un
 * campo: un PATCH vacio casi siempre es un bug del cliente, no una
 * peticion legitima.
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
