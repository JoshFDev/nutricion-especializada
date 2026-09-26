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

/*
 * requiereAdmin se elimino.
 *
 * Era un segundo filtro, paralelo al de permisos, que preguntaba por el
 * ROL (fn_es_admin()) en vez de por lo que el permiso concede. Las cinco
 * rutas de /api/usuarios lo usaban; ahora van por requierePermiso y ya
 * no queda ninguna ruta que lo llame.
 *
 * Se quito en vez de dejarlo sin usar por una razon: con las dos cosas
 * vivas, la proxima ruta que "necesite ser de admin" se escribe con el
 * que el autor encuentre primero, y el resultado es un sistema donde la
 * mitad de las rutas se audita en la tabla de permisos y la otra mitad en
 * el codigo. Un solo camino.
 *
 * Lo que `requiereAdmin` protegia de mas, el poder crear cuentas, sigue
 * protegido: usuarios.crear no se le concede a nadie salvo al
 * administrador (migracion 0006), el trigger de 0001 se niega a dejar el
 * sistema sin administrador activo, y la guarda ULTIMO_ADMIN del
 * servicio de usuarios avisa antes de llegar ahi.
 */
