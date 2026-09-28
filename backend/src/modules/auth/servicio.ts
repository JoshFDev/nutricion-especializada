import type { PoolClient } from 'pg';
import { ErrorValidacion, NoAutenticado, NoEncontrado } from '../../core/errores.js';
import { env } from '../../config/entorno.js';
import { generarToken, hashToken } from '../../middleware/sesion.js';
import { enTransaccionDe } from '../../db/transaccion.js';
import * as repo from './repositorio.js';
import {
  mapearUsuario,
  type CambiarContrasena,
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

/**
 * Cambio de contrasena con la sesion viva.
 *
 * Se pide la contrasena ACTUAL a proposito: sin ella, basta con que te
 * roben el token para quedarse con la cuenta para siempre.
 */
export async function cambiarContrasena(
  cliente: PoolClient,
  usuarioId: number,
  sesionId: number,
  datos: CambiarContrasena,
): Promise<{ sesionesCerradas: number }> {
  if (!(await repo.verificarContrasena(cliente, usuarioId, datos.actual))) {
    throw new ErrorValidacion('No se pudo cambiar la contrasena', [
      { campo: 'actual', problema: 'La contrasena actual no es correcta' },
    ]);
  }

  // O se cambia la contrasena y se cierran las sesiones, o no se hace
  // nada. Sin esto, si el UPDATE entra y el de sesiones revienta,
  // el ladron conserva el acceso con la contrasena vieja.
  //
  // Se usa enTransaccionDe y no enTransaccion a proposito: ambas comparten
  // el MISMO cliente. Si se pidiera uno nuevo al pool, perderiamos el GUC
  // app.usuario_id y el trigger de auditoria registraria la operacion
  // como si la hubiera hecho el usuario NULL.
  let sesionesCerradas = 0;

  await enTransaccionDe(cliente, async (c) => {
    const cambiada = await repo.cambiarContrasena(c, usuarioId, datos.nueva);
    if (!cambiada) {
      // verificarContrasena dixo hace un momento que estaba activo, asi
      // que esto es una carrera: alguien lo desactivo entre ambas consultas.
      throw new NoAutenticado('La cuenta ya no esta activa');
    }
    sesionesCerradas = await repo.cerrarOtrasSesiones(c, usuarioId, sesionId);
  });

  return { sesionesCerradas };
}

/**
 * Entra como el primer usuario del rol, sin preguntar la contrasena.
 *
 * SOLO para desarrollo, y solo mientras la ruta este montada (ver
 * `rutas-dev.ts` y el `if` de `app.ts`). La garantia de que esto no existe
 * en produccion no es que la ruta compruebe el modo y niegue: es que el
 * router NO SE MONTA, y la peticion cae en el 404 del final de `app.ts`.
 * Depende de un `if` en un solo lugar y no de acordarse de esconder un
 * boton.
 *
 * Lo que crea es una sesion de verdad para una persona de verdad: mismo
 * token, misma fila en `sesiones`, mismos permisos, misma auditoria. Por
 * eso sirve para probar todo lo que viene despues (los 45 permisos, el PDF,
 * los 403) sin que este camino se comporte distinto al de verdad. Un atajo
 * que fabricase una sesion de mentira arreglaria justo las cosas que hay
 * que probar.
 */
export async function entrarComo(
  cliente: PoolClient,
  rol: string,
  ctx: ContextoPeticion,
): Promise<RespuestaLogin> {
  const usuario = await repo.buscarPorRol(cliente, rol);
  if (!usuario) {
    throw new NoEncontrado(
      `No hay ningun usuario activo con el rol ${rol}. Carga el seed (db/seeds/seed_demo.sql)`,
    );
  }

  await repo.limpiarPendientesDeContrasena(cliente, Number(usuario.id));

  const token = generarToken();
  await repo.crearSesion(cliente, {
    usuarioId: Number(usuario.id),
    correo: usuario.email ?? `(sin correo: ${usuario.nombre})`,
    tokenHash: hashToken(token),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    duracion: env.JWT_EXPIRES_IN,
    // Queda escrito en la bitacora que esta sesion no vino de teclear una
    // contrasena. Ver la nota de `detalle` en `repo.crearSesion`.
    detalle: `acceso directo de desarrollo como ${rol}, sin contrasena`,
  });

  return { token, usuario: mapearUsuario(usuario) };
}
