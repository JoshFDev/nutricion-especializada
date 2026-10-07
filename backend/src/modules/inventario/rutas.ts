import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  crearMovimientoEsquema,
  idMovimientoEsquema,
  listarExistenciaEsquema,
  listarMovimientosEsquema,
} from './esquemas.js';
import { controladorInventario as controlador } from './controlador.js';

/**
 * Rutas de inventario.
 *
 * La lectura es de todos los que ven inventario. Escribir un movimiento
 * manual pide `inventario.ajustar`, que es justo el permiso que el trigger
 * `trg_permiso_inventario` (0001) exige para insertar o borrar un movimiento
 * sin referencia: la API no inventa permisos, expone los que la base ya
 * pedia. `inventario.merma` existe en la tabla de permisos pero la base solo
 * enforza `ajustar`, asi que los endpoints usan el de la base.
 *
 * El DELETE es, como el de caja, un borrado que queda en la bitacora: el
 * trigger escribe el antes y el despues en `auditoria_inventario`. Pero a
 * diferencia de caja, aqui NO se borra cualquier movimiento: solo los
 * manuales, porque los de compra y venta los genera el trigger de su
 * documento y borrarlos desfasa un documento que sigue vivo.
 */
export const rutasInventario = Router();

rutasInventario.use(requiereSesion);

rutasInventario.get(
  '/existencia',
  requierePermiso('inventario.ver'),
  validarQuery(listarExistenciaEsquema),
  controlador.listarExistencia,
);

rutasInventario.get(
  '/movimientos',
  requierePermiso('inventario.ver'),
  validarQuery(listarMovimientosEsquema),
  controlador.listarMovimientos,
);

rutasInventario.post(
  '/movimientos',
  requierePermiso('inventario.ajustar'),
  validarBody(crearMovimientoEsquema),
  controlador.crearMovimiento,
);

rutasInventario.delete(
  '/movimientos/:id',
  requierePermiso('inventario.ajustar'),
  validarParams(idMovimientoEsquema),
  controlador.eliminarMovimiento,
);
