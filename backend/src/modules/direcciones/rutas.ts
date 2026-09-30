import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams } from '../../core/validacion.js';
import { crearDireccionEsquema, idDireccionEsquema } from './esquemas.js';
import { controladorDirecciones } from './controlador.js';

/**
 * Rutas de /api/direcciones-entrega.
 *
 * Las direcciones de entrega son de la SUCURSAL y no de los clientes, asi que
 * cuelgan de su propio recurso y no de `/api/clientes/:id/direcciones`. La
 * razon es de negocio y no de organizacion del codigo: la misma direccion la
 * usan varios clientes y la elige quien captura la nota, no quien la compro.
 * Colgarlas del cliente obligaria a crear el cliente antes de poder capturar
 * la nota, que es justo el orden equivocado en un mostrador.
 *
 * `PUT` y no `PATCH`: el recurso tiene dos campos y se mandan los dos. Un
 * PATCH partial obligaria a la pantalla a saber cuales cambio para no borrar
 * el otro, y aqui no hay una razon para esa mitad de codigo.
 */
export const rutasDirecciones = Router();

const ctrl = controladorDirecciones;

rutasDirecciones.use(requiereSesion);

rutasDirecciones.get('/', requierePermiso('direcciones.ver'), ctrl.listar);

rutasDirecciones.post(
  '/',
  requierePermiso('direcciones.crear'),
  validarBody(crearDireccionEsquema),
  ctrl.crear,
);

rutasDirecciones.put(
  '/:id',
  requierePermiso('direcciones.editar'),
  validarParams(idDireccionEsquema),
  validarBody(crearDireccionEsquema),
  ctrl.actualizar,
);

rutasDirecciones.delete(
  '/:id',
  requierePermiso('direcciones.eliminar'),
  validarParams(idDireccionEsquema),
  ctrl.borrar,
);
