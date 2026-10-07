import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
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
 * ANTES estas rutas iban por `requiereAdmin`, que pregunta por el ROL con
 * fn_es_admin() y no por el permiso. Ahora las cinco van por permiso
 * granular, igual que el resto de la aplicacion.
 *
 * Que antes fussen las mas cerradas del sistema no era casual: con
 * `usuarios.crear` concedido a un rol, ese rol podia crear un
 * Administrador nuevo y con eso escalar privilegios. Ese riesgo no
 * desaparece al cambiar a granular, se traslada. Por eso los tres
 * permisos usuarios.* siguen siendo los unicos que la migracion 0006 no
 * le concede a la Cajera: el control ya no esta en el codigo, esta en la
 * tabla de permisos, y desde ahi si se puede auditar quien tiene que ver.
 *
 * El escalar privilegios sigue frenado por dos capas que NO se tocaron:
 * el trigger de 0001 que se niega a dejar al sistema sin administrador
 * activo, y la guarda ULTIMO_ADMIN del servicio. Ambas usan la misma
 * definicion que fn_es_admin().
 */

export const rutasUsuarios = Router();

rutasUsuarios.use(requiereSesion);

// --- Permisos CRUD normales -------------------------------------------

// /roles lo necesita el formulario de edicion para mostrar la lista de
// roles disponibles, asi que va por usuarios.ver y no por un permiso
// aparte. Es el mismo permiso que el listado, y es a proposito: si
// alguien puede ver cuentas, puede ver con que roles se les cambia.
rutasUsuarios.get(
  '/roles',
  requierePermiso('usuarios.ver'),
  validarQuery(listarUsuariosEsquema),
  controlador.listarRoles,
);

// Los fondos de login. Mismo permiso que el listado por la misma razon que
// /roles: el formulario de edicion los necesita para el selector, y quien
// puede ver cuentas ya puede verlas todas.
rutasUsuarios.get('/fondos', requierePermiso('usuarios.ver'), controlador.listarFondos);

rutasUsuarios.get(
  '/',
  requierePermiso('usuarios.ver'),
  validarQuery(listarUsuariosEsquema),
  controlador.listar,
);

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

// --- Escribir cuentas --------------------------------------------------
// Estas tres las movieron de "solo el administrador" a permiso granular.
// En la practica es lo mismo que antes (0006 no le da usuarios.* a la
// Cajera ni a la Empleada), pero ahora el control se puede revisar en la
// tabla de permisos en vez de estar escondido en el codigo.

rutasUsuarios.post(
  '/',
  requierePermiso('usuarios.crear'),
  validarBody(crearUsuarioEsquema),
  controlador.crear,
);

rutasUsuarios.put(
  '/:id/roles',
  requierePermiso('usuarios.editar'),
  validarParams(idUsuarioEsquema),
  validarBody(asignarRolesEsquema),
  controlador.asignarRoles,
);

rutasUsuarios.post(
  '/:id/resetear-contrasena',
  requierePermiso('usuarios.editar'),
  validarParams(idUsuarioEsquema),
  controlador.resetearContrasena,
);
