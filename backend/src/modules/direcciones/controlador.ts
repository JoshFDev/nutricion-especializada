import type { Request, Response } from 'express';
import { cuerpo, parametros } from '../../core/validacion.js';
import type { CrearDireccion } from './esquemas.js';
import * as servicio from './servicio.js';

/**
 * Capa HTTP del catalogo de direcciones.
 *
 * Aqui NO hay reglas de negocio ni SQL, como en todos los controladores del
 * proyecto: eso vive en `servicio.ts`.
 */

type Resp = (req: Request, res: Response) => Promise<void>;

const listar: Resp = async (req, res) => {
  res.json(await servicio.listar(req.db));
};

const crear: Resp = async (req, res) => {
  const { nombre, direccion } = cuerpo<CrearDireccion>(req);
  const fila = await servicio.crear(req.db, { nombre, direccion });
  res.status(201).location(`/api/direcciones-entrega/${fila.id}`).json(fila);
};

const actualizar: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  const { nombre, direccion } = cuerpo<CrearDireccion>(req);
  res.json(await servicio.actualizar(req.db, id, { nombre, direccion }));
};

const borrar: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  await servicio.borrar(req.db, id);
  res.status(204).end();
};

export const controladorDirecciones = { listar, crear, actualizar, borrar };
