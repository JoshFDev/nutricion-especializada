import { Router } from 'express';
import { requiereSesion, requierePermiso } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  cancelarNotaEsquema,
  crearNotaEsquema,
  crearTalonarioEsquema,
  editarNotaEsquema,
  idNotaEsquema,
  listarFoliosEsquema,
  listarNotasEsquema,
} from './esquemas.js';
import { controladorFolios, controladorNotas } from './controlador.js';

/**
 * Rutas de /api/notas-remision.
 *
 * Es el punto de venta, y por eso hay tres cosas que no se ven en las
 * firmas pero deciden si el modulo sirve:
 *
 * 1. NO HAY DELETE en /:id. Una nota no se borra, se cancela
 *    (`POST /:id/cancelar`). Borrarla dejaria el folio quemado para
 *    siempre, porque `fn_controlar_folio` no tiene contraparte: el folio
 *    queda en 'usado' y ninguna nota lo referencia, o sea un numero
 *    perdido en la numeracion sin documento que lo justifique. Ademas el
 *    kardoex y el saldo del cliente se destrozan.
 *
 * 2. La edicion va con `notas.editar` y la cancelacion con
 *    `notas.cancelar`, que NO son el mismo permiso: 0001 los da a
 *    Administrador y Cajera, y no a la Empleada. Editar una nota es
 *    corregir un Capture; cancelarla es deshacer un cobro, y esa
 *    diferencia es la que se respeta aqui.
 *
 * 3. El talonario tiene permiso propio (`notas.folios`, solo
 *    Administrador) y esta en el mismo archivo porque es la otra mitad de
 *    este modulo: los folios de remision son de este talonario o no
 *    existen.
 */
export const rutasNotasRemision = Router();

const ctrl = controladorNotas;

rutasNotasRemision.use(requiereSesion);

// ------------------------------------------------------------------ folios
//
// Antes que las notas, por el mismo motivo que `/efectivo` en precios: son
// rutas literales y Express las compara antes que las de recurso.

rutasNotasRemision.get(
  '/folios',
  requierePermiso('notas.ver'),
  validarQuery(listarFoliosEsquema),
  controladorFolios.listar,
);

rutasNotasRemision.post(
  '/folios',
  requierePermiso('notas.folios'),
  validarBody(crearTalonarioEsquema),
  controladorFolios.crearTalonario,
);

// ------------------------------------------------------------------- notas

rutasNotasRemision.get(
  '/',
  requierePermiso('notas.ver'),
  validarQuery(listarNotasEsquema),
  ctrl.listar,
);

rutasNotasRemision.post(
  '/',
  requierePermiso('notas.crear'),
  validarBody(crearNotaEsquema),
  ctrl.crear,
);

rutasNotasRemision.get(
  '/:id',
  requierePermiso('notas.ver'),
  validarParams(idNotaEsquema),
  ctrl.consultar,
);

// El PDF va con `notas.ver` y no con un permiso propio: imprimir no es una
// operacion distinta de ver, y un permiso aparte solo serviria para que
// alguien se quede sin poder imprimir su propia nota. Lo que SI protege el
// modulo (editar, cancelar, folios) sigue igual que antes.
//
// Va DESPUES de `/:id` a proposito, aunque Express lo resolveria igual:
// `/:id` y `/:id/pdf` no se pisan porque tienen distinto numero de
// segmentos. Este archivo pone las rutas literales primero por si manana
// aparece una, y esta se queda donde esta.
rutasNotasRemision.get(
  '/:id/pdf',
  requierePermiso('notas.ver'),
  validarParams(idNotaEsquema),
  ctrl.pdf,
);

rutasNotasRemision.patch(
  '/:id',
  requierePermiso('notas.editar'),
  validarParams(idNotaEsquema),
  validarBody(editarNotaEsquema),
  ctrl.editar,
);

rutasNotasRemision.post(
  '/:id/cancelar',
  requierePermiso('notas.cancelar'),
  validarParams(idNotaEsquema),
  validarBody(cancelarNotaEsquema),
  ctrl.cancelar,
);
