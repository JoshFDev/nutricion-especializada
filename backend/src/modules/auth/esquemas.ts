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
