import type { Request, Response } from 'express';
import { cuerpo, parametros } from '../../core/validacion.js';
import type { CrearCatalogo } from './esquemas.js';
import type { ClaveRecurso } from './repositorio.js';
import * as servicio from './servicio.js';

/**
 * Capa HTTP del catalogo.
 *
 * Un solo juego de manejadores sirve para las dos rutas: se fabrican con
 * el recurso ya cerrado. La alternativa era colgar un `req.recurso` en el
 * tipo global de Express, y ensuciar el request de toda la app por un
 * detalle de este modulo no vale la pena.
 *
 * Aqui NO hay reglas de negocio ni SQL.
 */

type Resp = (req: Request, res: Response) => Promise<void>;

export const controladorCatalogo = (clave: ClaveRecurso) => {
  const listar: Resp = async (req, res) => {
    res.json(await servicio.listar(req.db, clave));
  };

  const obtener: Resp = async (req, res) => {
    const { id } = parametros<{ id: number }>(req);
    res.json(await servicio.obtener(req.db, clave, id));
  };

  const crear: Resp = async (req, res) => {
    const { nombre } = cuerpo<CrearCatalogo>(req);
    const fila = await servicio.crear(req.db, clave, nombre);
    res
      .status(201)
      .location(`/api/${rutaDe(clave)}/${fila.id}`)
      .json(fila);
  };

  const renombrar: Resp = async (req, res) => {
    const { id } = parametros<{ id: number }>(req);
    const { nombre } = cuerpo<CrearCatalogo>(req);
    res.json(await servicio.renombrar(req.db, clave, id, nombre));
  };

  const borrar: Resp = async (req, res) => {
    const { id } = parametros<{ id: number }>(req);
    await servicio.borrar(req.db, clave, id);
    res.status(204).end();
  };

  return { listar, obtener, crear, renombrar, borrar };
};

/** Como se llama el recurso en la URL. */
const rutaDe = (clave: ClaveRecurso): string =>
  clave === 'categorias' ? 'categorias-producto' : 'especies';
