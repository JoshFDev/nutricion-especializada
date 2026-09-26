import type { NextFunction, Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { NoAutenticado } from '../core/errores.js';

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
      /**
       * Cliente de Postgres DEDICADO a este request. Todo el SQL del
       * request debe salir de aqui, nunca del pool: la identidad del
       * usuario viaja en el GUC de la conexion, asi que dos peticiones
       * concurrentes no pueden compartirla.
       */
      db: PoolClient;
      sesion: Sesion | null;
    }
  }
}

const CABECERA = 'authorization';
const PREFIJO = 'bearer ';

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** 32 bytes aleatorios en base64url: ~256 bits de entropia. */
export const generarToken = (): string => randomBytes(32).toString('base64url');

/** Comparacion en tiempo constante: no filtra cuantos bytes del hash
 *  coinciden, asi que no sirve para adivinar un token byte a byte. */
export const compararTokens = (a: string, b: string): boolean => {
  const bufA = Buffer.from(hashToken(a), 'hex');
  const bufB = Buffer.from(hashToken(b), 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

function extraerToken(req: Request): string | null {
  const cabecera = req.headers[CABECERA];
  if (typeof cabecera !== 'string' || !cabecera.toLowerCase().startsWith(PREFIJO)) {
    return null;
  }
  const token = cabecera.slice(PREFIJO.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Deja la identidad del usuario en la conexion para que los triggers la
 * vean via fn_usuario_actual().
 *
 * Se fija con scope de SESION (is_local = false) y no con
 * fn_iniciar_sesion(), que usa scope de transaccion y se perderia al
 * terminar la sentencia. A cambio hay que limpiarlo antes de devolver la
 * conexion al pool: si no, el siguiente usuario que la tome hereda la
 * identidad del anterior y la base creeria que es el.
 */
export async function fijarUsuario(
  cliente: PoolClient,
  usuarioId: number | null,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  await cliente.query(
    `SELECT set_config('app.usuario_id',    COALESCE($1::TEXT, ''), false),
            set_config('app.usuario_ip',    COALESCE($2, ''),      false),
            set_config('app.usuario_agente', COALESCE($3, ''),     false)`,
    [usuarioId === null ? null : String(usuarioId), ip, userAgent],
  );
}

/**
 * Verifica el token y expone req.sesion / req.db.
 *
 * Si no hay token valido, req.sesion queda en null y cada ruta decide si
 * necesita sesion. La validacion del token es una consulta a `sesiones`:
 * el token es opaco y la base es la fuente de verdad, asi que un token
 * revocado deja de servir al instante, sin esperar a que expire su firma.
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
  req.sesion = null;

  // 'finish' = respuesta enviada. 'close' = el cliente se fue antes.
  // Sin los dos, una peticion abortada deja la conexion huerfana.
  let liberado = false;
  res.once('finish', liberar);
  res.once('close', liberar);

  function liberar() {
    if (liberado) return;
    liberado = true;
    limpiarYDevolver(cliente).catch(() => {
      /* si la conexion esta muerta no hay nada que devolver */
    });
  }

  try {
    const token = extraerToken(req);
    if (token) {
      // El tipo explicito importa: sin el, `pg` devuelve any y cualquier
      // renombrado de columna en el SQL pasaria desapercibido hasta el
      // runtime (fila.sesion_id seria undefined sin avisar).
      interface FilaSesion {
        sesion_id: string;
        usuario_id: string;
        nombre: string;
        email: string | null;
        debe_cambiar_contrasena: boolean;
      }

      const { rows } = await cliente.query<FilaSesion>(
        `SELECT s.id         AS sesion_id,
                s.usuario_id,
                u.nombre,
                u.email,
                u.debe_cambiar_contrasena
           FROM sesiones s
           JOIN usuarios u ON u.id = s.usuario_id
          WHERE s.token_hash  = $1
            AND s.cerrada_en  IS NULL
            AND s.expira_en   > now()
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
      cliente,
      req.sesion?.usuarioId ?? null,
      req.ip ?? null,
      req.get('user-agent') ?? null,
    );
    next();
  } catch (error) {
    next(error);
  }
}

async function limpiarYDevolver(cliente: PoolClient): Promise<void> {
  try {
    await cliente.query(
      `SELECT set_config('app.usuario_id', '', false),
              set_config('app.usuario_ip', '', false),
              set_config('app.usuario_agente', '', false)`,
    );
  } finally {
    cliente.release();
  }
}

/** Corta la cadena si no hay sesion. Reexportado por comodidad. */
export function exigirSesion(req: Request, _res: Response, next: NextFunction): void {
  if (!req.sesion) {
    next(new NoAutenticado());
    return;
  }
  next();
}
