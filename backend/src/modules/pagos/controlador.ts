import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import * as servicio from './servicio.js';
import type { CrearPago, ListarPagos } from './esquemas.js';

/**
 * Traduce HTTP a servicio. No decide nada: si hay una regla, vive en
 * `servicio.ts`, y no se ve ni la base de datos.
 */
export const controladorPagos = {
  listar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listar(req.db, consulta<ListarPagos>(req)));
  },

  consultar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.consultar(req.db, parametros<{ id: number }>(req).id));
  },

  crear: async (req: Request, res: Response): Promise<void> => {
    // El `Location` es parte del contrato del 201 y no es inventado para este
    // modulo: clientes, productos, precios, usuarios y catalogo ya lo mandan.
    const pago = await servicio.crear(req.db, cuerpo<CrearPago>(req));
    res.status(201).location(`/api/pagos/${pago.id}`).json(pago);
  },
};
