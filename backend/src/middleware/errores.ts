import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/entorno.js';

export class ErrorHttp extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
    readonly detalles?: unknown,
  ) {
    super(mensaje);
    this.name = 'ErrorHttp';
  }
}

export const noEncontrado = (mensaje = 'Recurso no encontrado') =>
  new ErrorHttp(404, mensaje);

/**
 * Ultimo middleware de la cadena: convierte cualquier error en JSON.
 * `next` con 4 argumentos es lo que le dice a Express que esto es un
 * manejador de errores y no una ruta normal.
 */
export function manejadorErrores(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'Datos inválidos',
      detalles: error.issues.map((i) => ({
        campo: i.path.join('.'),
        problema: i.message,
      })),
    });
    return;
  }

  if (error instanceof ErrorHttp) {
    res.status(error.estado).json({
      error: error.message,
      ...(error.detalles ? { detalles: error.detalles } : {}),
    });
    return;
  }

  // 23505 = violacion de unicidad, 23503 = llave foranea.
  // Son errores del cliente, no del servidor, y el mensaje de Postgres
  // se puede filtrar tal cual.
  const pg = error as { code?: string; detail?: string; message?: string };
  if (pg.code === '23505') {
    res.status(409).json({ error: 'Ya existe un registro con esos datos', detalle: pg.detail });
    return;
  }
  if (pg.code === '23503') {
    res.status(409).json({ error: 'El registro hace referencia a algo que no existe', detalle: pg.detail });
    return;
  }
  if (pg.code === '42501') {
    // Lo lanza fn_exigir_permiso: falta permiso en la base.
    res.status(403).json({ error: 'Permiso insuficiente', detalle: pg.message });
    return;
  }
  if (pg.code === 'P0001' && typeof pg.message === 'string') {
    // raise_exception de los triggers de la base (folios, saldos, pagos).
    res.status(400).json({ error: pg.message });
    return;
  }

  console.error('Error no controlado:', error);
  res.status(500).json({
    error: 'Error interno del servidor',
    // En produccion nunca sefiltran los detalles internos.
    ...(env.NODE_ENV === 'development' && error instanceof Error
      ? { detalle: error.message }
      : {}),
  });
}
