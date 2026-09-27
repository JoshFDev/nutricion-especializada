import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import { NoAutenticado } from '../../core/errores.js';
import * as servicio from './servicio.js';
import type {
  CancelarNota,
  CrearNota,
  CrearTalonario,
  EditarNota,
  ListarFolios,
  ListarNotas,
} from './esquemas.js';

/**
 * Manejadores de notas de remision.
 *
 * Cada uno lee de `cuerpo()` / `consulta()` / `parametros()`, nunca de
 * `req.body`: leer el pedido crudo se salta la validacion, y el tipo que
 * declara el esquema es la unica garantia de que el campo existe.
 *
 * `usuarioId` NO viene del cuerpo. Viene de la sesion, y por eso
 * `vendedor_id` no esta en el esquema de alta: si el campo existiera,
 * alguien podria escribir en nombre de otro. `fn_auditoria` (0001) saca al
 * usuario de la sesion, asi que el INSERT de la cabecera tendria un
 * vendedor y la auditoria otro, y la venta seria de Fulano pero quedaria
 * auditada como de Mengano.
 */
const usuarioDeLaSesion = (req: Request): number => {
  if (!req.sesion) {
    // No deberia pasar: todas las rutas montan `requiereSesion`. Si
    // Alguna vez pasa, es un hueco de seguridad, no un dato faltante.
    // 401 y no 403: falta la credencial, no el permiso. Con 403 el cliente
    // prueba otras credenciales; con 401 sabe que tiene que abrir sesion.
    throw new NoAutenticado('No hay sesion iniciada');
  }
  return req.sesion.usuarioId;
};

export const controladorNotas = {
  listar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listar(req.db, consulta<ListarNotas>(req)));
  },

  consultar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.consultar(req.db, parametros<{ id: number }>(req).id));
  },

  crear: async (req: Request, res: Response): Promise<void> => {
    res
      .status(201)
      .json(await servicio.crear(req.db, cuerpo<CrearNota>(req), usuarioDeLaSesion(req)));
  },

  editar: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await servicio.editar(req.db, parametros<{ id: number }>(req).id, cuerpo<EditarNota>(req)),
    );
  },

  cancelar: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await servicio.cancelar(
        req.db,
        parametros<{ id: number }>(req).id,
        cuerpo<CancelarNota>(req).motivo,
      ),
    );
  },
};

export const controladorFolios = {
  listar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listarFolios(req.db, consulta<ListarFolios>(req)));
  },

  crearTalonario: async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await servicio.crearTalonario(req.db, cuerpo<CrearTalonario>(req)));
  },
};
