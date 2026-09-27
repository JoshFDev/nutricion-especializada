import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  actualizarProveedorEsquema,
  crearProveedorEsquema,
  idProveedorEsquema,
  listarProveedoresEsquema,
} from './esquemas.js';
import { controladorProveedores as controlador } from './controlador.js';

/**
 * Rutas de proveedores.
 *
 * El alta y la edicion piden `proveedores.editar` las dos, y no por
 *conomicidad de permisos sino porque es el unico que existe: la tabla de
 * permisos (0001) no tiene `proveedores.crear` ni `proveedores.eliminar`.
 * Agregar uno nuevo para darlo solo al admin dejaria a la Cajera sin poder
 * capturar un proveedor, y esta no es una operacion delicada.
 *
 * No hay DELETE: la baja es `activo: false` por PATCH, y ya lo aplica
 * `compras` cuando el proveedor esta dado de baja.
 */
export const rutasProveedores = Router();

rutasProveedores.use(requiereSesion);

rutasProveedores.get(
  '/',
  requierePermiso('proveedores.ver'),
  validarQuery(listarProveedoresEsquema),
  controlador.listar,
);

rutasProveedores.get(
  '/:id',
  requierePermiso('proveedores.ver'),
  validarParams(idProveedorEsquema),
  controlador.consultar,
);

rutasProveedores.post(
  '/',
  requierePermiso('proveedores.editar'),
  validarBody(crearProveedorEsquema),
  controlador.crear,
);

rutasProveedores.patch(
  '/:id',
  requierePermiso('proveedores.editar'),
  validarParams(idProveedorEsquema),
  validarBody(actualizarProveedorEsquema),
  controlador.actualizar,
);
