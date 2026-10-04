import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import type { ActualizarUsuario, AsignarRoles, CrearUsuario, ListarUsuarios } from './esquemas.js';
import { FONDOS_LOGIN } from './fondos-login.js';
import * as servicio from './servicio.js';

/**
 * Capa HTTP: traduce la peticion a una llamada de servicio y la respuesta
 * a un status + JSON. Aqui NO hay reglas de negocio ni SQL.
 *
 * `req.sesion.usuarioId` y `req.sesion.sesionId` son los dos datos que el
 * servicio necesita para las reglas de candado (no te desactives a ti
 * mismo, no te cierres tu propia sesion).
 */

export const listar = async (req: Request, res: Response): Promise<void> => {
  const q = consulta<ListarUsuarios>(req);
  res.json(await servicio.listar(req.db, q));
};

export const obtener = async (req: Request, res: Response): Promise<void> => {
  const { id } = parametros<{ id: number }>(req);
  res.json(await servicio.obtener(req.db, id));
};

export const listarRoles = async (req: Request, res: Response): Promise<void> => {
  res.json(await servicio.roles(req.db));
};

/**
 * Los fondos de login que se pueden elegir.
 *
 * No consulta la base: es la constante de `fondos-login.ts`. Va como endpoint y
 * no como algo fijo en el frontend porque la lista cambia con una migracion, y
 * duplicarla en el cliente seria tener dos verdades que se desincronizan sin
 * que nada avise.
 */
export const listarFondos = async (_req: Request, res: Response): Promise<void> => {
  res.json({ datos: FONDOS_LOGIN });
};

export const crear = async (req: Request, res: Response): Promise<void> => {
  const datos = cuerpo<CrearUsuario>(req);
  const resultado = await servicio.crear(req.db, req.sesion!.usuarioId, datos);
  res.status(201).location(`/api/usuarios/${resultado.usuario.id}`).json(resultado);
};

export const actualizar = async (req: Request, res: Response): Promise<void> => {
  const { id } = parametros<{ id: number }>(req);
  const datos = cuerpo<ActualizarUsuario>(req);
  res.json(await servicio.actualizar(req.db, req.sesion!.usuarioId, id, datos));
};

export const asignarRoles = async (req: Request, res: Response): Promise<void> => {
  const { id } = parametros<{ id: number }>(req);
  const datos = cuerpo<AsignarRoles>(req);
  res.json(await servicio.asignarRoles(req.db, req.sesion!.usuarioId, id, datos));
};

export const resetearContrasena = async (req: Request, res: Response): Promise<void> => {
  const { id } = parametros<{ id: number }>(req);
  const { sesionId } = req.sesion!;
  res.json(await servicio.resetearContrasena(req.db, id, sesionId));
};
