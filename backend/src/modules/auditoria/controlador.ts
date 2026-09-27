import type { Request, Response } from 'express';
import { consulta } from '../../core/validacion.js';
import * as repo from './repositorio.js';
import type {
  ListarAccesos,
  ListarAuditoriaCaja,
  ListarAuditoriaInventario,
  ListarAuditoriaPrecios,
  ListarLog,
} from './esquemas.js';

/**
 * El unico controlador de solo lectura del proyecto.
 *
 * No hay `crear`, `actualizar` ni `eliminar` y no se van a agregar. Las cinco
 * bitacoras se llenan por trigger (`trg_auditoria_*` y `fn_auditoria` de
 * 0001), y si hubiera un endpoint de escritura el mismo usuario que robo
 * una contrasena podria borrar la fila que dice que la robo.
 *
 * En cuanto al cuerpo del `POST`: el middleware valida el body solo en rutas
 * que lo declaran con `validarBody`, y aqui ninguna lo hace, asi que no se
 * mira lo que venga. Para un GET no hay nada que validar.
 */
export const controladorAuditoria = {
  log: async (req: Request, res: Response): Promise<void> => {
    res.json(await repo.listarLog(req.db, consulta<ListarLog>(req)));
  },

  accesos: async (req: Request, res: Response): Promise<void> => {
    res.json(await repo.listarAccesos(req.db, consulta<ListarAccesos>(req)));
  },

  caja: async (req: Request, res: Response): Promise<void> => {
    res.json(await repo.listarCaja(req.db, consulta<ListarAuditoriaCaja>(req)));
  },

  inventario: async (req: Request, res: Response): Promise<void> => {
    res.json(await repo.listarInventario(req.db, consulta<ListarAuditoriaInventario>(req)));
  },

  precios: async (req: Request, res: Response): Promise<void> => {
    res.json(await repo.listarPrecios(req.db, consulta<ListarAuditoriaPrecios>(req)));
  },
};
