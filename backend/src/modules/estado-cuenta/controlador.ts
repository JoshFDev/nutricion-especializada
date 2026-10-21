import type { Request, Response } from 'express';
import { consulta, parametros } from '../../core/validacion.js';
import * as servicio from './servicio.js';
import type { GeneralEstadoCuenta, HojaEstadoCuenta, ListarEstadoCuenta } from './esquemas.js';

/**
 * Traduce HTTP a servicio. No decide nada: si hay una regla, vive en
 * `servicio.ts`, y no se ve ni la base de datos.
 */
export const controladorEstadoCuenta = {
  /** El listado de clientes con su saldo. */
  listar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listar(req.db, consulta<ListarEstadoCuenta>(req)));
  },

  /**
   * La hoja de estado de cuenta de un cliente.
   *
   * Mismo molde que el excel de las notas: el `Buffer` se arma completo y se
   * manda de un solo `send`, asi el manejador de errores puede seguir
   * devolviendo su JSON si algo falla. Va como `attachment`, porque un `.xlsx`
   * no se abre en el navegador: se descarga.
   *
   * El `renglonesFuera` viaja en una cabecera y no en el cuerpo, porque la
   * respuesta es un archivo y no JSON: la hoja solo trae 20 filas, y asi el
   * frontend puede avisar que la cuenta tiene mas movimientos de los que caben.
   */
  hoja: async (req: Request, res: Response): Promise<void> => {
    const p = parametros<HojaEstadoCuenta>(req);
    const { bytes, nombreArchivo, renglonesFuera } = await servicio.hoja(
      req.db,
      p.id,
      p.rango ?? 'todo',
      p.rango === 'personalizado'
        ? { fecha_inicio: p.fecha_inicio, fecha_fin: p.fecha_fin }
        : undefined,
    );
    res
      .setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`)
      .setHeader('Cache-Control', 'no-store')
      .setHeader('X-Renglones-Fuera', String(renglonesFuera))
      .send(bytes);
  },

  general: async (req: Request, res: Response): Promise<void> => {
    const cuerpo = req.body as GeneralEstadoCuenta | undefined;
    const clienteIds = cuerpo?.cliente_ids ?? [];
    const { bytes, nombreArchivo, renglonesFuera, escritos } = await servicio.general(
      req.db,
      clienteIds,
    );
    res
      .setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`)
      .setHeader('Cache-Control', 'no-store')
      .setHeader('X-Renglones-Fuera', String(renglonesFuera))
      .setHeader('X-Renglones-Escritos', String(escritos))
      .send(bytes);
  },
};
