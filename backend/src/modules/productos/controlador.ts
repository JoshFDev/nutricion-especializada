import type { Request, Response } from 'express';
import { consulta, cuerpo, parametros } from '../../core/validacion.js';
import type { ActualizarProducto, CrearProducto, ListarProductos } from './esquemas.js';
import * as servicio from './servicio.js';

/**
 * Capa HTTP de productos.
 *
 * Aqui NO hay reglas de negocio ni SQL: es translator puro de HTTP a
 * servicio y de vuelta. Si algo de este archivo necesita saber si un
 * producto esta en uso, es que se metio en la capa equivocada.
 */

type Resp = (req: Request, res: Response) => Promise<void>;

const listar: Resp = async (req, res) => {
  res.json(await servicio.listar(req.db, consulta<ListarProductos>(req)));
};

const obtener: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  res.json(await servicio.obtener(req.db, id));
};

const crear: Resp = async (req, res) => {
  const datos = cuerpo<CrearProducto>(req);
  const producto = await servicio.crear(req.db, datos);
  res.status(201).location(`/api/productos/${producto.id}`).json(producto);
};

const actualizar: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  res.json(await servicio.actualizar(req.db, id, cuerpo<ActualizarProducto>(req)));
};

const borrar: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  await servicio.borrar(req.db, id);
  res.status(204).end();
};

export const controladorProductos = { listar, obtener, crear, actualizar, borrar };
