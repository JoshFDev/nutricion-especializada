import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarQuery } from '../../core/validacion.js';
import {
  reporteAlertasEsquema,
  reporteConsumoEsquema,
  reporteEstadoCuentaEsquema,
  reporteExistenciaEsquema,
} from './esquemas.js';
import { controladorReportes as controlador } from './controlador.js';

/**
 * Rutas de reportes. Cuatro GET, todos con el mismo permiso.
 *
 * Hay un solo permiso (`reportes.ver`) para las cuatro y no es un atajo: las
 * cuatro son de solo lectura y ninguna trae precios, asi que separarlas daria
 * cuatro permisos que se conceden siempre juntos. La razon larga esta en la
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

/**
 * Las alertas de la base.
 *
 * La tabla `alertas` la llenan los triggers (hoy, el de stock negativo) y
 * antes no la leia nadie: crecia sin limite y el aviso no llegaba a ninguna
 * pantalla. El estado actual del stock si se ve en la pantalla de
 * inventario; esto es el HISTORICO de cuando se quedo sin.
 */
rutasReportes.get(
  '/alertas',
  requierePermiso('reportes.ver'),
  validarQuery(reporteAlertasEsquema),
  controlador.alertas,
);

/**
 * La conciliacion entre la cartera y la caja.
 *
 * Un cobro se anota en dos tablas (la cartera y la caja) y el vinculo entre
 * las dos permite cruzarlas. Esto dice si hay cobros que no llegaron a la
 * caja, o que llegaron con otro monto.
 */
rutasReportes.get('/conciliacion-caja', requierePermiso('reportes.ver'), controlador.conciliacion);
