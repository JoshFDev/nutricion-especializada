import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { ErrorHttp } from './errores.js';

export interface Sesion {
  usuarioId: number;
  nombre: string;
  email: string | null;
  sesionId: number;
  debeCambiarContrasena: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Cliente dedicado a este request. Usar SIEMPRE este, no el pool. */
      db: PoolClient;
      sesion: Sesion | null;
    }
  }
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** 32 bytes aleatorios en base64url: ~256 bits de entropia. */
export const generarToken = (): string => randomBytes(32).toString('base64url');

/**
 * Deja el usuario en la conexion para que los triggers de la base lo vean
 * via fn_usuario_actual().
 *
 * Importante: se fija con scope de SESION (is_local = false) y no con
 * fn_iniciar_sesion(), que usa scope de transaccion y se perderia al
 * terminar la sentencia. A cambio hay que limpiarlo antes de devolver la
 * conexion al pool, o el siguiente usuario que la tome heredaria la
 * identidad del anterior.
 */
export async function fijarUsuario(
  cliente: PoolClient,
  usuarioId: number | null,
  ip: string | null,
  userAgent: string | null = null,
): Promise<void> {
  await cliente.query(
    `SELECT set_config('app.usuario_id',   COALESCE($1::TEXT, ''), false),
            set_config('app.usuario_ip',   COALESCE($2, ''),      false),
            set_config('app.usuario_agente', COALESCE($3, ''),     false)`,
    [usuarioId === null ? null : String(usuarioId), ip, userAgent],
  );
}

function extraerToken(req: Request): string | null {
  const cabecera = req.headers.authorization;
  if (!cabecera?.startsWith('Bearer ')) return null;
  const token = cabecera.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Devuelve la conexion al pool limpiando antes el GUC de identidad.
 *
 * Se dispara con el evento 'finish' de la respuesta, no como middleware:
 * una ruta que responde bien NO llama a next(), asi que un middleware de
 * cierre nunca se ejecutaria y cada request quemaria una conexion.
 */
function liberarConexion(cliente: PoolClient): void {
  cliente
    .query(
      `SELECT set_config('app.usuario_id', '', false),
              set_config('app.usuario_ip', '', false),
              set_config('app.usuario_agente', '', false)`,
    )
    .catch(() => {
      // Si la conexion esta muerta no hay nada que limpiar: se descarta.
    })
    .finally(() => cliente.release());
}

/**
 * Verifica el token, abre la sesion de base de datos y expone
 * req.sesion / req.db. Si no hay token valido, req.sesion queda en null
 * y cada ruta decide si necesita sesion.
 */
export async function prepararSesion(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let cliente: PoolClient;
  try {
    cliente = await pool.connect();
  } catch (error) {
    next(error);
    return;
  }

  req.db = cliente;
  // 'finish' = respuesta enviada. 'close' = cliente se fue antes de tiempo.
  // Sin los dos, una peticion abortada deja la conexion huérfana.
  let liberado = false;
  const liberar = () => {
    if (liberado) return;
    liberado = true;
    liberarConexion(cliente);
  };
  res.on('finish', liberar);
  res.on('close', liberar);

  try {
    const token = extraerToken(req);
    if (token) {
      const { rows } = await req.db.query(
        `SELECT s.id                AS sesion_id,
                s.usuario_id,
                u.nombre,
                u.email,
                u.activo,
                u.debe_cambiar_contrasena
           FROM sesiones s
           JOIN usuarios u ON u.id = s.usuario_id
          WHERE s.token_hash = $1
            AND s.cerrada_en IS NULL
            AND s.expira_en > now()
            AND u.activo`,
        [hashToken(token)],
      );

      const fila = rows[0];
      if (fila) {
        req.sesion = {
          sesionId: Number(fila.sesion_id),
          usuarioId: Number(fila.usuario_id),
          nombre: String(fila.nombre),
          email: fila.email === null ? null : String(fila.email),
          debeCambiarContrasena: Boolean(fila.debe_cambiar_contrasena),
        };
      }
    }

    await fijarUsuario(
      req.db,
      req.sesion?.usuarioId ?? null,
      req.ip ?? null,
      req.get('user-agent') ?? null,
    );
    next();
  } catch (error) {
    next(error);
  }
}

/** Corta la cadena si no hay sesion iniciada. */
export function requiereSesion(req: Request, _res: Response, next: NextFunction): void {
  if (!req.sesion) {
    next(new ErrorHttp(401, 'Necesitas iniciar sesion'));
    return;
  }
  next();
}

/**
 * Corta la cadena si al usuario le falta el permiso. La base tambien lo
 * comprueba (fn_trg_permiso), pero fallar aqui da un 403 claro en vez de
 * un error de Postgres a media consulta.
 */
export function requierePermiso(codigo: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.sesion) {
      next(new ErrorHttp(401, 'Necesitas iniciar sesion'));
      return;
    }
    const { rows } = await req.db.query('SELECT fn_tiene_permiso($1) AS ok', [codigo]);
    if (!rows[0]?.ok) {
      next(new ErrorHttp(403, `Tu rol no tiene el permiso ${codigo}`));
      return;
    }
    next();
  };
}
