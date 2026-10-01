import type { Request, Response } from 'express';
import { cuerpo, consulta, parametros } from '../../core/validacion.js';
import { NoAutenticado } from '../../core/errores.js';
import * as servicio from './servicio.js';
import type {
  CancelarNota,
  CrearNota,
  CrearTalonario,
  EditarNota,
  EstablecerSerieActiva,
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

  /**
   * La nota en PDF.
   *
   * Es la unica respuesta del proyecto que NO es JSON, asi que se arma el
   * `Buffer` completo y se manda entero con `send`. Al mandar bytes ya
   * hechos, cualquier error de armado ya ocurrio antes de tocar la
   * respuesta, asi que el manejador de errores de `app.ts` sigue pudiendo
   * devolver su JSON. Con `doc.pipe(res)` eso ya no seria cierto.
   *
   * `inline` y no `attachment`: asi el navegador lo abre en su visor de PDF
   * y el operador lo imprime con un ctrl+P sin guardarlo antes en
   * `Descargas`, que es lo que pasa en el mostrador. El nombre del archivo
   * va en `filename` de todos modos, asi que guardarlo a mano tambien sale
   * con el nombre correcto.
   *
   * El cache va apagado: un PDF con el mismo nombre y contenido distinto
   * (misma nota, impresa otra vez) tiene que salir el de ahora.
   */
  pdf: async (req: Request, res: Response): Promise<void> => {
    const { bytes, nombreArchivo, renglonesFuera } = await servicio.pdf(
      req.db,
      parametros<{ id: number }>(req).id,
    );
    res
      .setHeader('Content-Type', 'application/pdf')
      .setHeader('Content-Disposition', `inline; filename="${nombreArchivo}"`)
      .setHeader('Cache-Control', 'no-store')
      // El PDF tiene los mismos nueve renglones que el Excel, asi que avisa
      // de los que no cupieron igual que el Excel. Sin esta cabecera el aviso
      // del frente nunca sale para el PDF, y el papel se imprime incompleto en
      // silencio.
      .setHeader('X-Renglones-Fuera', String(renglonesFuera))
      .send(bytes);
  },

  /**
   * La nota en Excel.
   *
   * Mismo molde que `pdf`: el `Buffer` se arma completo y se manda de un
   * solo `send`, asi el manejador de errores puede seguir devolviendo su
   * JSON si algo falla. `attachment` en vez de `inline`: el Excel no se
   * abre en el navegador como el PDF, se descarga (y en la oficina se
   * imprime desde Excel si quieren).
   *
   * El `renglonesFuera` va en una cabecera, no en el cuerpo: la respuesta
   * es un archivo y no JSON, y el navegador/`fetch` no leeria un JSON
   * pegado al final. Con `X-Renglones-Fuera` el frontend sabe cuantos
   * renglones no cupieron antes de abrir la descarga.
   */
  excel: async (req: Request, res: Response): Promise<void> => {
    const { bytes, nombreArchivo, renglonesFuera } = await servicio.excel(
      req.db,
      parametros<{ id: number }>(req).id,
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

  exportarExcel: async (req: Request, res: Response): Promise<void> => {
    const bytes = await servicio.exportarExcel(req.db, consulta<ListarNotas>(req));
    const nombre = `notas-remision-${new Date().toISOString().split('T')[0]}.xlsx`;
    res
      .setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader('Content-Disposition', `attachment; filename="${nombre}"`)
      .setHeader('Cache-Control', 'no-store')
      .send(bytes);
  },
};

export const controladorFolios = {
  listar: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.listarFolios(req.db, consulta<ListarFolios>(req)));
  },

  resumen: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.resumenDeTalonarios(req.db));
  },

  leerSerieActiva: async (req: Request, res: Response): Promise<void> => {
    res.json(await servicio.leerSerieActiva(req.db));
  },

  establecerSerieActiva: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await servicio.establecerSerieActiva(req.db, cuerpo<EstablecerSerieActiva>(req).serie),
    );
  },

  crearTalonario: async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await servicio.crearTalonario(req.db, cuerpo<CrearTalonario>(req)));
  },
};
