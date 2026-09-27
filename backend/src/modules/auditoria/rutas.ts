import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarQuery } from '../../core/validacion.js';
import {
  listarAccesosEsquema,
  listarAuditoriaCajaEsquema,
  listarAuditoriaInventarioEsquema,
  listarAuditoriaPreciosEsquema,
  listarLogEsquema,
} from './esquemas.js';
import { controladorAuditoria as controlador } from './controlador.js';

/**
 * Rutas de auditoria. Todas GET, todas con paginacion.
 *
 * La separacion de permisos es de lectura, no de operacion: `auditoria.ver`
 * alcanza para todo lo que no sea historial de logins, y
 * `auditoria.accesos` es el permiso que hay que tener aparte para ver
 * `auditoria_accesos`, que incluye IP, user agent y el nombre de usuario que
 * se tecleo en los intentos fallidos. Esa tabla si es sensible de forma
 * distinta: no dice que se movio un precio, dice a que hora entra la gente
 * al sistema, y por eso lleva un permiso propio en vez de caer en el mismo
 * que el resto de los cambios.
 *
 * Ojo con la ruta `/accesos` y el middleware de `/:id` que tienen los otros
 * modulos: aqui no hay `/:id` en ninguna de las cinco, asi que no hay
 * colision, y `log` tambien es fija.
 */
export const rutasAuditoria = Router();

rutasAuditoria.use(requiereSesion);

rutasAuditoria.get(
  '/log',
  requierePermiso('auditoria.ver'),
  validarQuery(listarLogEsquema),
  controlador.log,
);

rutasAuditoria.get(
  '/accesos',
  requierePermiso('auditoria.accesos'),
  validarQuery(listarAccesosEsquema),
  controlador.accesos,
);

rutasAuditoria.get(
  '/caja',
  requierePermiso('auditoria.caja'),
  validarQuery(listarAuditoriaCajaEsquema),
  controlador.caja,
);

rutasAuditoria.get(
  '/inventario',
  requierePermiso('auditoria.inventario'),
  validarQuery(listarAuditoriaInventarioEsquema),
  controlador.inventario,
);

rutasAuditoria.get(
  '/precios',
  requierePermiso('auditoria.precios'),
  validarQuery(listarAuditoriaPreciosEsquema),
  controlador.precios,
);
