import type { NextFunction, Request, Response } from 'express';
import { NoAutenticado, Prohibido } from '../core/errores.js';

/** Corta la cadena si no hay sesion iniciada. */
export function requiereSesion(req: Request, _res: Response, next: NextFunction): void {
  if (!req.sesion) {
    next(new NoAutenticado());
    return;
  }
  next();
}

/**
 * Corta la cadena si al usuario le falta el permiso.
 *
 * La base de datos tambien lo comprueba (fn_trg_permiso) y es la ultima
 * linea de defensa, pero fallar aqui da un 403 limpio en vez de un error
 * de Postgres a media consulta. Los dos se necesitan: el permiso cambia
 * entre peticiones, el SQL de una consulta ya esta escrito.
 */
export function requierePermiso(codigo: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const sesion = req.sesion;
    if (!sesion) {
      next(new NoAutenticado());
      return;
    }
    try {
      // Sin el tipo, `pg` devuelve any y `rows[0].ok` pasaria sin revisar.
      const { rows } = await req.db.query<{ ok: boolean }>('SELECT fn_tiene_permiso($1) AS ok', [
        codigo,
      ]);
      if (!rows[0]?.ok) {
        next(new Prohibido(`Tu rol no tiene el permiso ${codigo}`));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Igual que requierePermiso, pero exige que el usuario sea duena/admin.
 * Para lo que no tiene un permiso granular, como ver la bitacora completa.
 */
export function requiereAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.sesion) {
    next(new NoAutenticado());
    return;
  }
  // Se escribe con async/await y no con .then() para que las dos funciones
  // de este archivo se lean igual.
  void (async () => {
    try {
      const { rows } = await req.db.query<{ ok: boolean }>('SELECT fn_es_admin() AS ok');
      if (!rows[0]?.ok) {
        next(new Prohibido('Esta accion es solo para administradores'));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  })();
}
