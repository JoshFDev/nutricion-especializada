import { z } from 'zod';

/**
 * OJO con el orden: `z.email().trim()` NO funciona. Zod aplica las
 * comprobaciones en el orden en que se encadenan, asi que el formato se
 * valida ANTES de recortar y un correo con espacios de mas ("  a@b.com",
 * tipico al copiar y pegar) se rechaza con "formato invalido" en vez de
 * entrar bien. Por eso se recorta primero con z.string().trim() y el
 * formato se comprueba despues.
 */
export const loginEsquema = z.object({
  correo: z.string().trim().max(200).pipe(z.email('El correo no tiene formato valido')),
  contrasena: z.string().min(1, 'La contrasena no puede ir vacia').max(200),
});

export type Login = z.infer<typeof loginEsquema>;

export interface UsuarioFila {
  id: string;
  nombre: string;
  email: string | null;
  activo: boolean;
  debe_cambiar_contrasena: boolean;
  puesto: string | null;
  contrasena_ok: boolean;
  permisos: string[] | null;
  roles: string[] | null;
}

export interface UsuarioPublico {
  id: number;
  nombre: string;
  email: string | null;
  puesto: string | null;
  debeCambiarContrasena: boolean;
}

/** Perfil del usuario autenticado, con lo que el frontend usa para
 *  ocultar botones: la lista de permisos y de roles. */
export interface Perfil extends UsuarioPublico {
  permisos: string[];
  roles: string[];
}

export interface RespuestaLogin {
  token: string;
  usuario: UsuarioPublico;
}

export const mapearUsuario = (fila: UsuarioFila): UsuarioPublico => ({
  id: Number(fila.id),
  nombre: fila.nombre,
  email: fila.email,
  puesto: fila.puesto,
  debeCambiarContrasena: fila.debe_cambiar_contrasena,
});

/**
 * Politica de contrasena. Se valida en el backend y NO en el frontend: si
 * la regla viviera solo en Angular, cualquiera podria saltarsela hablando
 * directo con el API.
 *
 * No imponemos simbolos raros: basta con 12 caracteres y tres clases.
 *
 * Se exporta porque el alta de usuario la usa tambien (ver
 * `usuarios/esquemas.ts`): cuando el administrador escribe la contrasena de la
 * persona en vez de que la genere el sistema, tiene que pasar por EXACTAMENTE
 * la misma regla que la que la persona va a tener que cumplir cuando entre a
 * cambiarla. Dos reglas parecidas en dos archivos son dos reglas distintas en
 * cuanto una se toca, y el fallo sale como "me deja dar de alta una clave que
 * despues no me acepta".
 */
export const contrasenaFuerte = z
  .string()
  .min(12, 'La contrasena necesita al menos 12 caracteres')
  .max(200, 'La contrasena es demasiado larga')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v), 'Debe tener mayusculas y minusculas')
  .refine((v) => /\d/.test(v), 'Debe incluir al menos un numero');

export const cambiarContrasenaEsquema = z
  .object({
    actual: z.string().min(1, 'Escribe tu contrasena actual').max(200),
    nueva: contrasenaFuerte,
  })
  .refine((d) => d.nueva !== d.actual, {
    message: 'La nueva contrasena debe ser distinta de la actual',
    path: ['nueva'],
  });

export type CambiarContrasena = z.infer<typeof cambiarContrasenaEsquema>;
