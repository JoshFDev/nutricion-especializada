import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import {
  AppError,
  Conflicto,
  ErrorValidacion,
  Prohibido,
  ReglaNegocio,
  esAppError,
} from '../core/errores.js';
import { env } from '../config/entorno.js';

/** Interfaz de los errores que lanza el driver de Postgres. */
interface ErrorPostgres {
  code?: string;
  detail?: string;
  constraint?: string;
  message: string;
}

/**
 * Traduce errores de PostgreSQL a errores de AppError.
 *
 * La base es la ultima linea de defensa: si algo llego aqui, es porque
 * nadie valido esa operacion antes. Estos codigos son errores del cliente
 * (o de la base), no del servidor, y responder 500 seria mentir.
 */
function desdePostgres(error: ErrorPostgres): AppError | null {
  switch (error.code) {
    case '23505': // unique_violation
      return new Conflicto('DUPLICADO', 'Ya existe un registro con esos datos', {
        constraint: error.constraint,
        detalle: error.detail,
      });
    case '23503': // foreign_key_violation
      return new Conflicto(
        'REFERENCIA_EN_USO',
        'El registro hace referencia a algo que no existe, o esta en uso',
        { constraint: error.constraint, detalle: error.detail },
      );
    case '23514': // check_violation
      return new ReglaNegocio('REGLA_NEGOCIO', 'La operacion viola una regla del negocio', {
        constraint: error.constraint,
        detalle: error.detail,
      });
    case '42501': // insufficient_privilege
      return new Prohibido(error.message);
    case 'P0001': // raise_exception de los triggers
      return new ReglaNegocio('REGLA_NEGOCIO', error.message);
    case '22P02': // invalid_text_representation
    case '22003': // numeric_value_out_of_range
      return new ErrorValidacion('Un valor enviado no tiene el formato correcto');
    case '57014': // query_canceled
      return new AppError(503, 'CONSULTA_CANCELADA', 'La consulta tardo demasiado');
    default:
      return null;
  }
}

/**
 * Manejador de errores de Express. Debe registrar 4 argumentos: con menos,
 * Express lo toma como middleware normal y nunca se ejecuta.
 *
 * Nota: NO hace falta envolver los handlers en try/catch. Express 5
 * detecta las promesas rechazadas y las manda aqui por su cuenta.
 */
export function manejadorErrores(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const contexto = {
    metodo: req.method,
    ruta: req.originalUrl,
    usuario: req.sesion?.usuarioId ?? null,
  };

  if (esAppError(error)) {
    if (error.estado >= 500) {
      console.error('Error de la aplicacion:', error.codigo, contexto, error.message);
    }
    res.status(error.estado).json({
      codigo: error.codigo,
      error: error.message,
      ...(error.detalles !== undefined ? { detalles: error.detalles } : {}),
    });
    return;
  }

  // Si un ZodError se escapa de una validacion, se traduce igual.
  if (error instanceof ZodError) {
    res.status(400).json({
      codigo: 'VALIDACION',
      error: 'Revisa los datos enviados',
      detalles: error.issues.map((i) => ({
        campo: i.path.join('.') || '(raiz)',
        problema: i.message,
      })),
    });
    return;
  }

  const dePostgres = desdePostgres(error as ErrorPostgres);
  if (dePostgres) {
    res.status(dePostgres.estado).json({
      codigo: dePostgres.codigo,
      error: dePostgres.message,
      ...(dePostgres.detalles !== undefined ? { detalles: dePostgres.detalles } : {}),
    });
    return;
  }

  // Cualquier otra cosa es un bug nuestro: 500 y nunca sefiltran detalles.
  console.error('Error no controlado:', contexto, error);
  res.status(500).json({
    codigo: 'ERROR_INTERNO',
    error: 'Error interno del servidor',
    ...(env.NODE_ENV === 'development' && error instanceof Error ? { detalle: error.message } : {}),
  });
}
