import { z } from 'zod';

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
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'No enviaste ningun campo para actualizar',
  });

export type ActualizarUsuario = z.infer<typeof actualizarUsuarioEsquema>;

export const asignarRolesEsquema = z.object({
  roles: z.array(z.coerce.number().int().positive()).min(1).max(5),
});

export type AsignarRoles = z.infer<typeof asignarRolesEsquema>;
