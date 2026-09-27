import type { Request, Response } from 'express';
import { consulta, cuerpo, parametros } from '../../core/validacion.js';
import type {
  ActualizarPrecioCliente,
  ActualizarPrecioPublico,
  CrearPrecioCliente,
  CrearPrecioPublico,
  ListarPreciosCliente,
  ListarPreciosPublicos,
  PrecioEfectivo,
} from './esquemas.js';
import * as servicio from './servicio.js';

/**
 * Capa HTTP de precios.
 *
 * Aqui NO hay reglas de negocio ni SQL: es translator puro de HTTP a
 * servicio y de vuelta. Si algo de este archivo necesita saber si una
 * vigencia se traslapa, es que se metio en la capa equivocada.
 *
 * Nota sobre `cerrar`: NO es un DELETE disfrazado. No hay DELETE en este
 * modulo, y `POST /cerrar` responde 200 con el precio ya cerrado en vez de
 * 204, porque el cliente que lo pide quiere ver la vigencia nueva para
 * confirmar que se guardo bien.
 */

type Resp = (req: Request, res: Response) => Promise<void>;

const listarPublicos: Resp = async (req, res) => {
  res.json(await servicio.listarPublicos(req.db, consulta<ListarPreciosPublicos>(req)));
};

const listarClientes: Resp = async (req, res) => {
  res.json(await servicio.listarClientes(req.db, consulta<ListarPreciosCliente>(req)));
};

const obtenerPublico: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  res.json(await servicio.obtenerPublico(req.db, id));
};

const obtenerCliente: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  res.json(await servicio.obtenerCliente(req.db, id));
};

const crearPublico: Resp = async (req, res) => {
  const precio = await servicio.crearPublico(req.db, cuerpo<CrearPrecioPublico>(req));
  res.status(201).location(`/api/precios/publicos/${precio.id}`).json(precio);
};

const crearCliente: Resp = async (req, res) => {
  const precio = await servicio.crearCliente(req.db, cuerpo<CrearPrecioCliente>(req));
  res.status(201).location(`/api/precios/clientes/${precio.id}`).json(precio);
};

const actualizarPublico: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  res.json(await servicio.actualizarPublico(req.db, id, cuerpo<ActualizarPrecioPublico>(req)));
};

const actualizarCliente: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  res.json(await servicio.actualizarCliente(req.db, id, cuerpo<ActualizarPrecioCliente>(req)));
};

const cerrarPublico: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  res.json(
    await servicio.cerrarPublico(req.db, id, cuerpo<{ vigente_hasta: string }>(req).vigente_hasta),
  );
};

const cerrarCliente: Resp = async (req, res) => {
  const { id } = parametros<{ id: number }>(req);
  res.json(
    await servicio.cerrarCliente(req.db, id, cuerpo<{ vigente_hasta: string }>(req).vigente_hasta),
  );
};

const efectivo: Resp = async (req, res) => {
  res.json(await servicio.efectivo(req.db, consulta<PrecioEfectivo>(req)));
};

export const controladorPrecios = {
  listarPublicos,
  listarClientes,
  obtenerPublico,
  obtenerCliente,
  crearPublico,
  crearCliente,
  actualizarPublico,
  actualizarCliente,
  cerrarPublico,
  cerrarCliente,
  efectivo,
};
