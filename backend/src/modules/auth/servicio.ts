import type { PoolClient } from 'pg';
import { NoAutenticado } from '../../core/errores.js';
import { env } from '../../config/entorno.js';
import { generarToken, hashToken } from '../../middleware/sesion.js';
import * as repo from './repositorio.js';
import {
  mapearUsuario,
  type Login,
  type RespuestaLogin,
  type Perfil,
  type UsuarioFila,
} from './esquemas.js';

/**
 * Reglas de sesion.
 *
 * Decision de diseno: el token es opaco (32 bytes aleatorios) y lo que
 * se guarda en `sesiones` es su sha256. No es un JWT porque aqui no
 * hace falta verificar sin base de datos: la app SI tiene la base, y
 * tenerla como fuente de verdad permite revocar una sesion al instante.
 * Un JWT seguiria valido hasta expirar su firma aunque el usuario se
 * hubiera dado de baja o le hubieran cambiado la contrasena.
 */

const MENSAJE_CREDENCIALES = 'Correo o contrasena incorrectos';

export interface ContextoPeticion {
  ip: string | null;
  userAgent: string | null;
}

export async function iniciarSesion(
  cliente: PoolClient,
  datos: Login,
  ctx: ContextoPeticion,
): Promise<RespuestaLogin> {
  const usuario = await repo.buscarPorCorreo(cliente, datos.correo, datos.contrasena);

  /**
   * Un solo mensaje y un solo status para "no existe" y "contraseña
   * mal". Si se distinguen, el endpoint sirve para averiguar que correos
   * estan registrados en el sistema.
   */
  const credencialesOk = usuario !== null && usuario.contrasena_ok && usuario.activo;

  if (!credencialesOk || !usuario) {
    await repo.registrarIntentoFallido(cliente, {
      usuarioId: usuario ? Number(usuario.id) : null,
      correo: datos.correo,
      ip: ctx.ip,
      detalle: usuario ? 'contrasena incorrecta' : 'usuario inexistente',
    });
    throw new NoAutenticado(MENSAJE_CREDENCIALES);
  }

  const token = generarToken();

  await repo.crearSesion(cliente, {
    usuarioId: Number(usuario.id),
    correo: datos.correo,
    tokenHash: hashToken(token),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    duracion: env.JWT_EXPIRES_IN,
  });

  return { token, usuario: mapearUsuario(usuario) };
}

export async function perfil(cliente: PoolClient, usuarioId: number): Promise<Perfil> {
  const fila: UsuarioFila | null = await repo.obtenerPerfil(cliente, usuarioId);
  if (!fila) {
    throw new NoAutenticado('La sesion ya no corresponde a ningun usuario');
  }
  return {
    ...mapearUsuario(fila),
    permisos: fila.permisos ?? [],
    roles: fila.roles ?? [],
  };
}

export async function cerrar(cliente: PoolClient, sesionId: number): Promise<void> {
  // Idempotente: cerrar dos veces la misma sesion no es un error.
  await repo.cerrarSesion(cliente, sesionId);
}
