import type { Request, Response } from 'express';
import { consulta, cuerpo, parametros } from '../../core/validacion.js';
import * as servicio from './servicio.js';
import type { CrearMovimiento, ListarExistencia, ListarMovimientos } from './esquemas.js';

/** Traduce HTTP a servicio. No decide nada. */
export const controladorInventario = {
  listarExistencia: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listarExistencia(req.db, consulta<ListarExistencia>(req)));
  },

  listarMovimientos: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listarMovimientos(req.db, consulta<ListarMovimientos>(req)));
  },

  crearMovimiento: async (req: Request, res: Response): Promise<void> => {
    const creado = await servicio.crearMovimiento(req.db, cuerpo<CrearMovimiento>(req));
    res.status(201).json(creado);
  },

  eliminarMovimiento: async (req: Request, res: Response): Promise<void> => {
    await servicio.eliminarMovimiento(req.db, parametros<{ id: number }>(req).id);
    res.status(204).end();
  },
};
