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

  exportarExcel: async (req: Request, res: Response): Promise<void> => {
    const bytes = await servicio.exportarExcel(req.db, consulta<ListarProveedores>(req));
    res
      .setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader('Content-Disposition', `attachment; filename="${nombreDelArchivo()}.xlsx"`)
      .send(bytes);
  },
};

/**
 * `proveedores-AAAAMMDD`.
 *
 * Sin la extensión: la pone el `Content-Disposition`, que es el que decide
 * el nombre que ve el navegador.
 */
function nombreDelArchivo(): string {
  return `proveedores-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
}
