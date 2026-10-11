import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarQuery } from '../../core/validacion.js';
import {
  reporteConsumoEsquema,
  reporteEstadoCuentaEsquema,
  reporteExistenciaEsquema,
} from './esquemas.js';
import { controladorReportes as controlador } from './controlador.js';

/**
 * Rutas de reportes. Tres GET, todos con el mismo permiso.
 *
 * Hay un solo permiso (`reportes.ver`) para las tres y no es un atajo: las
 * tres son de solo lectura y ninguna trae precios, asi que separarlas daria
 * tres permisos que se conceden siempre juntos. La razon larga esta en la
 * migracion 0016.
 *
 * Los caminos son `kebab-case` como el resto de la API y son fijos, asi que
 * no compiten con ningun `/:id` (aqui no hay).
 */
export const rutasReportes = Router();

rutasReportes.use(requiereSesion);

rutasReportes.get(
  '/existencia',
  requierePermiso('reportes.ver'),
  validarQuery(reporteExistenciaEsquema),
  controlador.existencia,
);

rutasReportes.get(
  '/consumo-semanal',
  requierePermiso('reportes.ver'),
  validarQuery(reporteConsumoEsquema),
  controlador.consumo,
);

rutasReportes.get(
  '/estado-cuenta',
  requierePermiso('reportes.ver'),
  validarQuery(reporteEstadoCuentaEsquema),
  controlador.estadoCuenta,
);
