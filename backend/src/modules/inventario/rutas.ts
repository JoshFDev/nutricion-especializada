import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarQuery } from '../../core/validacion.js';
import { listarExistenciaEsquema } from './esquemas.js';
import { controladorInventario as controlador } from './controlador.js';

/**
 * Rutas de inventario.
 *
 * Una sola, y es de lectura. `inventario.ajustar` e `inventario.merma` ya
 * existen como permisos y como triggers, pero ningun endpoint las expone:
 * escriben en `auditoria_inventario` con el antes y el despues, y eso quiere
 * su propia pantalla con su motivo obligatorio, no un endpoint colado aqui.
 */
export const rutasInventario = Router();

rutasInventario.use(requiereSesion);

rutasInventario.get(
  '/existencia',
  requierePermiso('inventario.ver'),
  validarQuery(listarExistenciaEsquema),
  controlador.listarExistencia,
);
