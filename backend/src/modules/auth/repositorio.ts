import type { PoolClient } from 'pg';
import { consultarUno } from '../../db/transaccion.js';
import type { UsuarioFila } from './esquemas.js';

/**
 * SQL del modulo de autenticacion.
 *
 * Nota sobre contrasenas: la comparacion se hace DENTRO de Postgres con
 * crypt(). El hash nunca sale de la base, y la contrasena en texto plano
 * solo existe en la memoria del proceso entre que se recibe y se manda a
 * esa consulta.
 */

export async function buscarPorCorreo(
  cliente: PoolClient,
  correo: string,
  contrasena: string,
): Promise<UsuarioFila | null> {
  return consultarUno<UsuarioFila>(
    cliente,
    `SELECT u.id,
            u.nombre,
            u.email,
            u.activo,
            u.debe_cambiar_contrasena,
            u.puesto,
            (u.contrasena IS NOT NULL
             AND crypt($2, u.contrasena) = u.contrasena) AS contrasena_ok
       FROM usuarios u
      WHERE lower(u.email) = lower($1)`,
    [correo, contrasena],
  );
}

export async function registrarIntentoFallido(
  cliente: PoolClient,
  datos: {
    usuarioId: number | null;
    correo: string;
    ip: string | null;
    detalle: string;
  },
): Promise<void> {
  await cliente.query(
    `INSERT INTO auditoria_accesos (usuario_id, usuario_intento, evento, ip, detalle)
     VALUES ($1, $2, 'login_fallido', $3, $4)`,
    [datos.usuarioId, datos.correo, datos.ip, datos.detalle],
  );
}

export async function crearSesion(
  cliente: PoolClient,
  datos: {
    usuarioId: number;
    correo: string;
    tokenHash: string;
    ip: string | null;
    userAgent: string | null;
    duracion: string;
    /**
     * Lo que se escribe en `auditoria_accesos.detalle`.
     *
     * Es parametro y no texto fijo porque hay una entrada que NO viene de
     * teclear una contrasena (el acceso directo de desarrollo, ver
     * `rutas-dev.ts`), y en la bitacora tiene que quedar escrito de donde
     * salio la sesion. Un `login_exitoso` indistinguible del otro seria una
     * pista falsa dentro de la propia bitacora que existe para saber eso.
     */
    detalle?: string;
  },
): Promise<void> {
  await cliente.query(
    `INSERT INTO sesiones (usuario_id, token_hash, ip, user_agent, expira_en)
     VALUES ($1, $2, $3, $4, now() + $5::interval)`,
    [datos.usuarioId, datos.tokenHash, datos.ip, datos.userAgent, datos.duracion],
  );
  await cliente.query(
    `INSERT INTO auditoria_accesos (usuario_id, usuario_intento, evento, ip, detalle)
     VALUES ($1, $2, 'login_exitoso', $3, $4)`,
    [datos.usuarioId, datos.correo, datos.ip, datos.detalle ?? 'sesion iniciada'],
  );
}

export async function obtenerPerfil(
  cliente: PoolClient,
  usuarioId: number,
): Promise<UsuarioFila | null> {
  return consultarUno<UsuarioFila>(
    cliente,
    `SELECT u.id, u.nombre, u.email, u.activo, u.debe_cambiar_contrasena, u.puesto,
            TRUE AS contrasena_ok,
            COALESCE((SELECT json_agg(p.codigo ORDER BY p.codigo)
                        FROM permisos p
                        JOIN roles_permisos rp ON rp.permiso_id = p.id
                        JOIN usuarios_roles ur ON ur.rol_id = rp.rol_id
                       WHERE ur.usuario_id = u.id), '[]'::json) AS permisos,
            (SELECT json_agg(r.nombre ORDER BY r.nombre)
               FROM roles r
               JOIN usuarios_roles ur ON ur.rol_id = r.id
              WHERE ur.usuario_id = u.id) AS roles
       FROM usuarios u
      WHERE u.id = $1`,
    [usuarioId],
  );
}

export async function cerrarSesion(cliente: PoolClient, sesionId: number): Promise<boolean> {
  const resultado = await cliente.query(
    `UPDATE sesiones
        SET cerrada_en = now(), cierre_motivo = 'logout'
      WHERE id = $1 AND cerrada_en IS NULL`,
    [sesionId],
  );
  return (resultado.rowCount ?? 0) > 0;
}

/** Sesiones muertas que se limpian al arrancar. Ver servicio.ts. */
export async function podarSesiones(cliente: PoolClient, diasAntiguedad: number): Promise<number> {
  const resultado = await cliente.query(
    `DELETE FROM sesiones
      WHERE cerrada_en IS NOT NULL
        AND cerrada_en < now() - ($1 || ' days')::interval`,
    [String(diasAntiguedad)],
  );
  return resultado.rowCount ?? 0;
}

/**
 * Compara la contrasena contra el hash guardado, dentro de Postgres.
 * Devuelve false en vez de lanzar para que el servicio decida el error.
 */
export async function verificarContrasena(
  cliente: PoolClient,
  usuarioId: number,
  contrasena: string,
): Promise<boolean> {
  const fila = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT crypt($2, contrasena) = contrasena AS ok
       FROM usuarios
      WHERE id = $1 AND activo`,
    [usuarioId, contrasena],
  );
  return fila?.ok === true;
}

/**
 * El hash se genera en la base con gen_salt: el hash nunca se arma en Node
 * ni viaja por el proceso. De paso baja el flag de cambio pendiente y
 * limpia el bloqueo por intentos fallidos, porque quien cambia su
 * contrasena ya demostro que es el dueno de la cuenta.
 */
export async function cambiarContrasena(
  cliente: PoolClient,
  usuarioId: number,
  nueva: string,
): Promise<boolean> {
  const resultado = await cliente.query(
    `UPDATE usuarios
        SET contrasena = crypt($2, gen_salt('bf', 12)),
            debe_cambiar_contrasena = false,
            intentos_fallidos = 0,
            bloqueado_hasta = NULL
      WHERE id = $1 AND activo`,
    [usuarioId, nueva],
  );
  return (resultado.rowCount ?? 0) > 0;
}

/**
 * Cierra TODAS las demas sesiones del usuario menos la actual.
 *
 * Es lo importante: si alguien cambio su contrasena porque se la
 * robaron, las sesiones del ladrón tienen que morir en el acto. Dejar la
 * sesion actual viva es para que no se cierre a si mismo y lose el
 * token que esta usando.
 */
export async function cerrarOtrasSesiones(
  cliente: PoolClient,
  usuarioId: number,
  sesionActualId: number,
): Promise<number> {
  // 'manual' es uno de los valores que admite el CHECK sesiones_cierre_motivo_check
  // ('logout','expiracion','manual','reinicio'). Cuando exista el runner de
  // migraciones se puede agregar un valor propio 'cambio_contrasena', que daria
  // mas precision al auditar, pero no es necesario para que funcione.
  const resultado = await cliente.query(
    `UPDATE sesiones
        SET cerrada_en = now(), cierre_motivo = 'manual'
      WHERE usuario_id = $1
        AND id <> $2
        AND cerrada_en IS NULL`,
    [usuarioId, sesionActualId],
  );
  return resultado.rowCount ?? 0;
}

/**
 * El primer usuario activo que tiene el rol pedido.
 *
 * Es del acceso directo de desarrollo (ver `rutas-dev.ts`) y por eso el
 * `ORDER BY u.id`: si la base de desarrollo tiene mas de un administrador
 * (y la tiene: el seed trae un administrador y quien lo creo), se entra
 * siempre al mismo, y las capturas de pantalla de un dia y otro son
 * comparables.
 */
export async function buscarPorRol(cliente: PoolClient, rol: string): Promise<UsuarioFila | null> {
  return consultarUno<UsuarioFila>(
    cliente,
    `SELECT u.id, u.nombre, u.email, u.activo, u.debe_cambiar_contrasena, u.puesto,
            TRUE AS contrasena_ok,
            COALESCE((SELECT json_agg(p.codigo ORDER BY p.codigo)
                        FROM permisos p
                        JOIN roles_permisos rp ON rp.permiso_id = p.id
                        JOIN usuarios_roles ur ON ur.rol_id = rp.rol_id
                       WHERE ur.usuario_id = u.id), '[]'::json) AS permisos,
            (SELECT json_agg(r.nombre ORDER BY r.nombre)
               FROM roles r
               JOIN usuarios_roles ur ON ur.rol_id = r.id
              WHERE ur.usuario_id = u.id) AS roles
       FROM usuarios u
       JOIN usuarios_roles ur ON ur.usuario_id = u.id
       JOIN roles r           ON r.id = ur.rol_id
      WHERE r.nombre = $1 AND u.activo
      ORDER BY u.id
      LIMIT 1`,
    [rol],
  );
}

/**
 * Deja la cuenta sin pendiente de cambiar la contrasena.
 *
 * Lo usa solo el acceso directo de desarrollo. El seed siembra a todos con
 * `debe_cambiar_contrasena` en TRUE (es lo correcto: nadie entra con una
 * contrasena que esta escrita en un archivo), asi que sin esto el boton de
 * entrar como administrador caeria de inmediato en la pantalla de cambiar
 * la contrasena, que es justo lo que se esta queriendo evitar.
 *
 * De paso limpia el bloqueo por intentos fallidos: si alguien quedo
 * bloqueado por teclear mal la clave de prueba, el boton de desarrollo
 * tambien se queda sin poder entrar, y eso no lo entiende nadie.
 */
export async function limpiarPendientesDeContrasena(
  cliente: PoolClient,
  usuarioId: number,
): Promise<void> {
  await cliente.query(
    `UPDATE usuarios
        SET debe_cambiar_contrasena = false,
            intentos_fallidos = 0,
            bloqueado_hasta = NULL
      WHERE id = $1`,
    [usuarioId],
  );
}
