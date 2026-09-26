import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  actualizarClienteEsquema,
  crearClienteEsquema,
  idClienteEsquema,
  listarClientesEsquema,
} from './esquemas.js';
import * as controlador from './controlador.js';

/**
 * Un modulo = rutas + controlador + servicio + repositorio + esquemas +
 * modelo, todos en su carpeta. Las rutas son lo UNICO que Express ve.
 *
 * Se lee de abajo hacia arriba: rutas.ts dice qué se expone, controlador
 * translates, servicio decide, repositorio ejecuta.
 */
export const rutasClientes = Router();

// Todas las rutas exigen sesion. El permiso especifico va en cada una:
// ver clientes es muy distinto a borrarlos.
rutasClientes.use(requiereSesion);

rutasClientes.get('/', validarQuery(listarClientesEsquema), controlador.listar);

rutasClientes.get('/:id', validarParams(idClienteEsquema), controlador.obtener);

rutasClientes.post(
  '/',
  requierePermiso('clientes.crear'),
  validarBody(crearClienteEsquema),
  controlador.crear,
);

rutasClientes.patch(
  '/:id',
  requierePermiso('clientes.editar'),
  validarParams(idClienteEsquema),
  validarBody(actualizarClienteEsquema),
  controlador.actualizar,
);

rutasClientes.delete(
  '/:id',
  requierePermiso('clientes.eliminar'),
  validarParams(idClienteEsquema),
  controlador.eliminar,
);
