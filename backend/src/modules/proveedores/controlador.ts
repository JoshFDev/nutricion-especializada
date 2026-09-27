import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import * as servicio from './servicio.js';
import type { ActualizarProveedor, CrearProveedor, ListarProveedores } from './esquemas.js';

/** Traduce HTTP a servicio. No decide nada. */
export const controladorProveedores = {
  listar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listar(req.db, consulta<ListarProveedores>(req)));
  },

  consultar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.consultar(req.db, parametros<{ id: number }>(req).id));
  },

  crear: async (req: Request, res: Response): Promise<void> => {
    const proveedor = await servicio.crear(req.db, cuerpo<CrearProveedor>(req));
    res.status(201).location(`/api/proveedores/${proveedor.id}`).json(proveedor);
  },

  actualizar: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await servicio.actualizar(
        req.db,
        parametros<{ id: number }>(req).id,
        cuerpo<ActualizarProveedor>(req),
      ),
    );
  },
};
