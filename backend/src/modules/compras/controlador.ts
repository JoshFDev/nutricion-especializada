import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import * as servicio from './servicio.js';
import type { CancelarCompra, CrearCompra, ListarCompras } from './esquemas.js';

/** Traduce HTTP a servicio. No decide nada. */
export const controladorCompras = {
  listar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listar(req.db, consulta<ListarCompras>(req)));
  },

  consultar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.consultar(req.db, parametros<{ id: number }>(req).id));
  },

  crear: async (req: Request, res: Response): Promise<void> => {
    const compra = await servicio.crear(req.db, cuerpo<CrearCompra>(req));
    res.status(201).location(`/api/compras/${compra.id}`).json(compra);
  },

  cancelar: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await servicio.cancelar(
        req.db,
        parametros<{ id: number }>(req).id,
        cuerpo<CancelarCompra>(req).motivo,
      ),
    );
  },

  pagar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.pagar(req.db, parametros<{ id: number }>(req).id));
  },
};
