import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarParams, validarQuery } from '../../core/validacion.js';
import { controladorEstadoCuenta as ctrl } from './controlador.js';
import { hojaEstadoCuentaEsquema, listarEstadoCuentaEsquema } from './esquemas.js';

/**
 * Rutas de /api/estado-cuenta.
 *
 * Son dos y las dos son de SOLO LECTURA: no hay `POST`, `PATCH` ni `DELETE`
 * porque no hay tabla que escribir. El listado sale de la vista
 * `vw_estado_cuenta_cliente` (la misma que usa el reporte del mismo nombre) y
 * la hoja se arma en memoria a partir de las ventas y los abonos del cliente.
 *
 * Las dos van con el permiso `estado_cuenta.ver`. Se separo de `reportes.ver`
 * a proposito (migracion 0017): el reporte es la vista de conjunto para quien
 * mira el negocio, y esta pantalla es la herramienta de cobranza del dia, con
 * una descarga por cliente. Concederlas por separado deja dar una sin la otra.
 *
 * La hoja NO cuelga de `/:id` a secas: el `:id` del recurso es el cliente y el
 * sufijo dice que se pide de el. Asi, si manana aparece `GET /:id` (el detalle
 * de la cuenta en JSON), no choca con la descarga.
 */
export const rutasEstadoCuenta = Router();

rutasEstadoCuenta.use(requiereSesion);

// El listado de clientes con su saldo. Mismo molde que el reporte: busqueda,
// el filtro de "solo con saldo" y paginacion.
rutasEstadoCuenta.get(
  '/',
  requierePermiso('estado_cuenta.ver'),
  validarQuery(listarEstadoCuentaEsquema),
  ctrl.listar,
);

// La hoja en Excel de UN cliente. Va como `attachment` desde el controlador.
rutasEstadoCuenta.get(
  '/:id/hoja',
  requierePermiso('estado_cuenta.ver'),
  validarParams(hojaEstadoCuentaEsquema),
  ctrl.hoja,
);
