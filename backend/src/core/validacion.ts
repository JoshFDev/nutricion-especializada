import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type ZodError, type ZodType } from 'zod';
import { ErrorValidacion } from './errores.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Datos ya validados y convertidos. El controlador usa ESTOS, no
       * req.body: si lee req.body se salta la validacion.
       */
      bodyValidado?: unknown;
      queryValidado?: unknown;
      paramsValidados?: unknown;
    }
  }
}

/** Convierte un ZodError en la lista de campos que ve el frontend. */
function aDetalles(error: ZodError) {
  return error.issues.map((i) => ({
    campo: i.path.join('.') || '(raiz)',
    problema: i.message,
    codigo: i.code,
  }));
}

function fallo(error: ZodError): never {
  throw new ErrorValidacion('Revisa los datos enviados', aDetalles(error));
}

export const validarBody =
  <T>(esquema: ZodType<T>): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const resultado = esquema.safeParse(req.body);
    if (!resultado.success) fallo(resultado.error);
    req.bodyValidado = resultado.data;
    next();
  };

export const validarQuery =
  <T>(esquema: ZodType<T>): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const resultado = esquema.safeParse(req.query);
    if (!resultado.success) fallo(resultado.error);
    req.queryValidado = resultado.data;
    next();
  };

export const validarParams =
  <T>(esquema: ZodType<T>): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const resultado = esquema.safeParse(req.params);
    if (!resultado.success) fallo(resultado.error);
    req.paramsValidados = resultado.data;
    next();
  };

/**
 * Accesores tipados. Si la ruta no declaro su esquema, esto revienta en
 * desarrollo en vez de devolver un objeto vacio en produccion.
 */
export const cuerpo = <T>(req: Request): T => {
  if (req.bodyValidado === undefined) {
    throw new Error('Falta validarBody() en esta ruta');
  }
  return req.bodyValidado as T;
};

export const consulta = <T>(req: Request): T => {
  if (req.queryValidado === undefined) {
    throw new Error('Falta validarQuery() en esta ruta');
  }
  return req.queryValidado as T;
};

export const parametros = <T>(req: Request): T => {
  if (req.paramsValidados === undefined) {
    throw new Error('Falta validarParams() en esta ruta');
  }
  return req.paramsValidados as T;
};
