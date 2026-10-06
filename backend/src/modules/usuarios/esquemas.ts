import { z } from 'zod';
import { contrasenaFuerte } from '../auth/esquemas.js';
import { esClaveFondo } from './fondos-login.js';

/**
 * Esquemas del modulo de usuarios.
 *
 * El RFC se valida aqui con la MISMA expresion que el CHECK de la tabla
 * (fn del 0001). Si solo existiera en la base, el usuario recibiria un
 * error de Postgres en vez de un mensaje util. Duplicar la regla es
 * aceptable; lo que NO se acepta es tener reglas distintas en los dos
 * lados, asi que si se cambia el CHECK hay que cambiar esta linea.
 */
const RFC = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

const texto = (max: number) => z.string().trim().min(1).max(max);

/**
 * La contrasena temporal que genera el sistema NO tiene que cumplir la
 * politica de contrasena fuerte: es de un solo uso y el usuario esta
 * obligado a cambiarla al entrar (debe_cambiar_contrasena). Exigirle
 * mayusculas y numeros a una clave que el usuario va a botar en cinco
 * minutos solo agrega friccion.
 */
export const contrasenaTemporal = z
  .string()
  .min(12, 'La contrasena temporal necesita al menos 12 caracteres')
  .max(200);

export const listarUsuariosEsquema = z.object({
  buscar: z.string().trim().min(1).max(200).optional(),
  rol: z.coerce.number().int().positive().optional(),
  // ?activo=true / ?activo=false. Sin esto no se puede listar solo los
  // dados de baja, que es justo lo que revisa el administrador.
  activo: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListarUsuarios = z.infer<typeof listarUsuariosEsquema>;

export const idUsuarioEsquema = z.object({
  id: z.coerce.number().int().positive(),
});

export const idUsuarioRolEsquema = z.object({
  id: z.coerce.number().int().positive(),
  rolId: z.coerce.number().int().positive(),
});

/**
 * `.strict()` en vez de la conducta por defecto de Zod (que es quitar lo
 * desconocido en silencio). Aqui tiene sentido ser estricto: si el
 * cliente manda `es_dueno: true` o `id`, preferredimos un 400 que diga
 * "ese campo no existe" a aceptarlo y que el servicio lo ignore. Un
 * cliente que se equivoca de campo se entera, en vez de descubrir tres
 * meses despues que su `es_dueno` nunca hizo nada.
 */
export const crearUsuarioEsquema = z.strictObject({
  nombre: texto(120),
  apellido_paterno: texto(120),
  apellido_materno: z.string().trim().max(120).nullish(),
  rfc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(RFC, 'El RFC no cumple el formato del SAT (12 o 13 caracteres)'),
  email: z.email('El correo no tiene formato valido').max(200).nullish(),
  puesto: z.string().trim().max(120).nullish(),
  /**
   * La contrasena, si el administrador quiere ponerla el.
   *
   * Opcional a proposito, y por backwards compatible: si no viene, el servicio
   * genera la temporal de siempre y el usuario tiene que cambiarla al entrar.
   * Ese camino se conserva porque hay clientes (y el seed) que no mandan este
   * campo, y porque sigue siendo valido como opcion.
   *
   * Cuando SI viene pasa por `contrasenaFuerte`, la MISMA regla de
   * `auth/esquemas.ts`. No se relaja para el alta: si se aceptara aqui algo
   * que despues no pasa `cambiarContrasenaEsquema`, el alta daria exito y el
   * primer ingreso dejaria al usuario con una clave que el sistema no le
   * reconoce. Ademas no es univilaje al administrador: el mensaje llega al
   * momento de dar de alta, no tres minutos despues en el login.
   *
   * `.trim()` NO va aqui a proposito. Las contrasenas admiten espacios
   *-leading y trailing de forma legitima, y recortarlos haria que la que el
   * administrador escribe no sea la que la persona teclea. El hash es del
   * valor exacto que llega.
   */
  contrasena: contrasenaFuerte.optional(),
  /**
   * Si se omite, se usa la fecha de hoy. Es NOT NULL y sin default en la
   * tabla, asi que o se manda o se rellena aqui.
   */
  fecha_contratacion: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD')
    .optional(),
  roles: z
    .array(z.coerce.number().int().positive())
    .min(1, 'El usuario necesita al menos un rol')
    .max(5)
    .default([2]),
});

export type CrearUsuario = z.infer<typeof crearUsuarioEsquema>;

export const actualizarUsuarioEsquema = z
  .object({
    nombre: texto(120).optional(),
    apellido_paterno: texto(120).optional(),
    apellido_materno: z.string().trim().max(120).nullish(),
    puesto: z.string().trim().max(120).nullish(),
    activo: z.boolean().optional(),
    // null = quitar la eleccion y volver al fondo por defecto. Se valida
    // contra la misma lista que usa el CHECK de 0013, para que el error
    // llegue como mensaje de zod y no como error de Postgres.
    fondo_login: z.string().trim().min(1).refine(esClaveFondo, 'Ese fondo no existe').nullish(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'No enviaste ningun campo para actualizar',
  });

export type ActualizarUsuario = z.infer<typeof actualizarUsuarioEsquema>;

export const asignarRolesEsquema = z.object({
  roles: z.array(z.coerce.number().int().positive()).min(1).max(5),
});

export type AsignarRoles = z.infer<typeof asignarRolesEsquema>;
