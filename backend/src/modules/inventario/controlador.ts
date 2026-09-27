import type { Request, Response } from 'express';
import { consulta } from '../../core/validacion.js';
import * as servicio from './servicio.js';
import type { ListarExistencia } from './esquemas.js';

/** Traduce HTTP a servicio. No decide nada. */
export const controladorInventario = {
  listarExistencia: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listarExistencia(req.db, consulta<ListarExistencia>(req)));
  },
};
