import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import * as servicio from './servicio.js';
import type {
  Cierre,
  CrearCuenta,
  CrearMovimiento,
  ListarCuentas,
  ListarMovimientos,
  Resumen,
} from './esquemas.js';

/**
 * Traduce HTTP a servicio. No decide nada: si hay una regla, vive en
 * `servicio.ts`, y no se ve ni la base de datos.
 */
export const controladorCaja = {
  listarCuentas: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listarCuentas(req.db, consulta<ListarCuentas>(req)));
  },

  consultarCuenta: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.consultarCuenta(req.db, parametros<{ id: number }>(req).id));
  },

  crearCuenta: async (req: Request, res: Response): Promise<void> => {
    const cuenta = await servicio.crearCuenta(req.db, cuerpo<CrearCuenta>(req));
    res.status(201).location(`/api/caja/cuentas/${cuenta.id}`).json(cuenta);
  },

  listarMovimientos: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listarMovimientos(req.db, consulta<ListarMovimientos>(req)));
  },

  consultarMovimiento: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.consultarMovimiento(req.db, parametros<{ id: number }>(req).id));
  },

  crearMovimiento: async (req: Request, res: Response): Promise<void> => {
    const movimiento = await servicio.crearMovimiento(req.db, cuerpo<CrearMovimiento>(req));
    res.status(201).location(`/api/caja/movimientos/${movimiento.id}`).json(movimiento);
  },

  eliminarMovimiento: async (req: Request, res: Response): Promise<void> => {
    await servicio.eliminarMovimiento(req.db, parametros<{ id: number }>(req).id);
    // 204 y sin cuerpo, a proposito: el DELETE no devuelve nada que el
    // operador pueda usar, y el saldo que si le interesa (el de la cuenta
    // despues del borrado) lo recalcula el trigger. Se vuelve a pedir
    // GET /api/caja/cuentas, que es barato y siempre esta al dia.
    res.status(204).end();
  },

  resumen: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.resumen(req.db, consulta<Resumen>(req)));
  },

  cierre: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.cierre(req.db, consulta<Cierre>(req)));
  },

  listarCategorias: async (req: Request, res: Response): Promise<void> => {
    const q = consulta<{ cuenta_id?: number }>(req);
    res.json(await servicio.listarCategorias(req.db, q.cuenta_id));
  },
};
