import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import type { ActualizarCliente, CrearCliente, ListarClientes } from './esquemas.js';
import * as servicio from './servicio.js';

/**
 * Capa HTTP: traduce la peticion a una llamada de servicio y la respuesta
 * a un status + JSON. Aqui NO hay reglas de negocio ni SQL.
 *
 * Los controladores son funciones sueltas en vez de clases: no hay estado
 * que compartir y una funcion se prueba y se lee mas rapido que un metodo.
 *
 * No hace falta try/catch: Express 5 manda las promesas rechazadas al
 * manejador de errores por su cuenta.
 */

export const listar = async (req: Request, res: Response): Promise<void> => {
  const q = consulta<ListarClientes>(req);
  const resultado = await servicio.listar(req.db, q);
  res.json(resultado);
};

export const obtener = async (req: Request, res: Response): Promise<void> => {
  const { id } = parametros<{ id: number }>(req);
  res.json(await servicio.obtener(req.db, id));
};

export const crear = async (req: Request, res: Response): Promise<void> => {
  const datos = cuerpo<CrearCliente>(req);
  const cliente = await servicio.crear(req.db, datos);
  res.status(201)
    .location(`/api/clientes/${cliente.id}`)
    .json(cliente);
};

export const actualizar = async (req: Request, res: Response): Promise<void> => {
  const { id } = parametros<{ id: number }>(req);
  const datos = cuerpo<ActualizarCliente>(req);
  res.json(await servicio.actualizar(req.db, id, datos));
};

export const eliminar = async (req: Request, res: Response): Promise<void> => {
  const { id } = parametros<{ id: number }>(req);
  await servicio.eliminar(req.db, id);
  res.status(204).end();
};
