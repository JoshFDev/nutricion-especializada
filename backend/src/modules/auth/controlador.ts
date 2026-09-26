import type { Request, Response } from 'express';
import { cuerpo } from '../../core/validacion.js';
import { NoAutenticado } from '../../core/errores.js';
import type { Login } from './esquemas.js';
import * as servicio from './servicio.js';

/**
 * Capa HTTP de la sesion. Sin reglas de negocio ni SQL: solotraduce
 * peticion -> servicio -> respuesta.
 *
 * Sin try/catch: Express 5 manda las promesas rechazadas al manejador de
 * errores global por su cuenta.
 */

export const login = async (req: Request, res: Response): Promise<void> => {
  const datos = cuerpo<Login>(req);
  const resultado = await servicio.iniciarSesion(req.db, datos, {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });
  res.status(200).json(resultado);
};

export const perfil = async (req: Request, res: Response): Promise<void> => {
  // requiereSesion ya garantiza esto; el if es solo para que TypeScript
  // no tenga que adivinar.
  if (!req.sesion) throw new NoAutenticado();
  res.json(await servicio.perfil(req.db, req.sesion.usuarioId));
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  if (!req.sesion) throw new NoAutenticado();
  await servicio.cerrar(req.db, req.sesion.sesionId);
  res.status(204).end();
};
