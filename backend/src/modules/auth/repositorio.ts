import type { PoolClient } from 'pg';
import { consultar, consultarUno } from '../../db/transaccion.js';
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
  },
): Promise<void> {
  await cliente.query(
    `INSERT INTO sesiones (usuario_id, token_hash, ip, user_agent, expira_en)
     VALUES ($1, $2, $3, $4, now() + $5::interval)`,
    [datos.usuarioId, datos.tokenHash, datos.ip, datos.userAgent, datos.duracion],
  );
  await cliente.query(
    `INSERT INTO auditoria_accesos (usuario_id, usuario_intento, evento, ip, detalle)
     VALUES ($1, $2, 'login_exitoso', $3, 'sesion iniciada')`,
    [datos.usuarioId, datos.correo, datos.ip],
  );
}

export async function obtenerPerfil(cliente: PoolClient, usuarioId: number): Promise<UsuarioFila | null> {
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
export async function podarSesiones(
  cliente: PoolClient,
  diasAntiguedad: number,
): Promise<number> {
  const resultado = await cliente.query(
    `DELETE FROM sesiones
      WHERE cerrada_en IS NOT NULL
        AND cerrada_en < now() - ($1 || ' days')::interval`,
    [String(diasAntiguedad)],
  );
  return resultado.rowCount ?? 0;
}
