import { Router } from 'express';
import { requiereAdmin, requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  actualizarUsuarioEsquema,
  asignarRolesEsquema,
  crearUsuarioEsquema,
  idUsuarioEsquema,
  listarUsuariosEsquema,
} from './esquemas.js';
import * as controlador from './controlador.js';

/**
 * Rutas del modulo de usuarios.
 *
 * Estas son las rutas mas cerradas del sistema. Crear cuentas, cambiar
 * roles y resetear contrasenas quedan solo para el administrador, sin
 * importar que permisos traiga su rol. Motivo: si el permiso
 * `usuarios.crear` se pudiera conceder a un rol cualquiera, ese rol
 * podria crear un Administrador nuevo y con eso escalar privilegios.
 * Quien puede crear administradores tiene que ser el administrador.
 *
 * Ver y editar si van por permiso granular, que es otra cosa: que alguien
 * pueda consultar o corregir el nombre de un compañero no le da control
 * sobre las cuentas.
 */

export const rutasUsuarios = Router();

rutasUsuarios.use(requiereSesion);

// --- Permisos CRUD normales -------------------------------------------

rutasUsuarios.get(
  '/roles',
  requiereAdmin,
  validarQuery(listarUsuariosEsquema),
  controlador.listarRoles,
);

rutasUsuarios.get('/', requiereAdmin, validarQuery(listarUsuariosEsquema), controlador.listar);

rutasUsuarios.get(
  '/:id',
  requierePermiso('usuarios.ver'),
  validarParams(idUsuarioEsquema),
  controlador.obtener,
);

rutasUsuarios.patch(
  '/:id',
  requierePermiso('usuarios.editar'),
  validarParams(idUsuarioEsquema),
  validarBody(actualizarUsuarioEsquema),
  controlador.actualizar,
);

// --- Solo el administrador --------------------------------------------

rutasUsuarios.post('/', requiereAdmin, validarBody(crearUsuarioEsquema), controlador.crear);

rutasUsuarios.put(
  '/:id/roles',
  requiereAdmin,
  validarParams(idUsuarioEsquema),
  validarBody(asignarRolesEsquema),
  controlador.asignarRoles,
);

rutasUsuarios.post(
  '/:id/resetear-contrasena',
  requiereAdmin,
  validarParams(idUsuarioEsquema),
  controlador.resetearContrasena,
);
