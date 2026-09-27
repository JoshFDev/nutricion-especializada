import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import * as servicio from './servicio.js';
import type { CambiarEstatus, CrearFactura, ListarFacturas } from './esquemas.js';

/**
 * Traduce HTTP a servicio. No decide nada: si hay una regla, vive en
 * `servicio.ts`, y no se ve ni la base de datos.
 */
export const controladorFacturacion = {
  listar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listar(req.db, consulta<ListarFacturas>(req)));
  },

  consultar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.consultar(req.db, parametros<{ id: number }>(req).id));
  },

  crear: async (req: Request, res: Response): Promise<void> => {
    const factura = await servicio.crear(req.db, cuerpo<CrearFactura>(req));
    res.status(201).location(`/api/facturas/${factura.id}`).json(factura);
  },

  cambiarEstatus: async (req: Request, res: Response): Promise<void> => {
    const { estatus, motivo } = cuerpo<CambiarEstatus>(req);
    res.json(
      await servicio.cambiarEstatus(req.db, parametros<{ id: number }>(req).id, estatus, motivo),
    );
  },
};
