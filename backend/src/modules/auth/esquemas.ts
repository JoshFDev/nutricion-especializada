import { z } from 'zod';

export const loginEsquema = z.object({
  correo: z.email('El correo no tiene formato valido').max(200).trim(),
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
 */
const contrasenaFuerte = z
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
