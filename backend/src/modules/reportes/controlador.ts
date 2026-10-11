import type { Request, Response } from 'express';
import { consulta } from '../../core/validacion.js';
import * as repo from './repositorio.js';
import type { ReporteConsumo, ReporteEstadoCuenta, ReporteExistencia } from './esquemas.js';

/**
 * El controlador de reportes, de solo lectura.
 *
 * No hay `crear`, `actualizar` ni `eliminar` y no se van a agregar: los tres
 * reportes son vistas calculadas por la base. Un endpoint que las escribiera
 * no tendria sentido (no hay tabla debajo que guardar) y si lo tuviera,
 * dejarian de ser el reflejo de lo que la base calcula.
 *
 * Las tres rutas declaran su `validarQuery`, asi que `consulta()` siempre
 * encuentra el objeto validado.
 */
export const controladorReportes = {
  existencia: async (req: Request, res: Response): Promise<void> => {
    res.json(await repo.listarExistencia(req.db, consulta<ReporteExistencia>(req)));
  },

  consumo: async (req: Request, res: Response): Promise<void> => {
    res.json(await repo.listarConsumo(req.db, consulta<ReporteConsumo>(req)));
  },

  estadoCuenta: async (req: Request, res: Response): Promise<void> => {
    res.json(await repo.listarEstadoCuenta(req.db, consulta<ReporteEstadoCuenta>(req)));
  },
};
