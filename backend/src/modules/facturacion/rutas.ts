import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  cambiarEstatusEsquema,
  crearFacturaEsquema,
  idFacturaEsquema,
  listarFacturasEsquema,
} from './esquemas.js';
import { controladorFacturacion as controlador } from './controlador.js';

/**
 * Rutas de facturacion.
 *
 * No hay DELETE. Cancelar una factura es un PATCH a `cancelada` con motivo, y
 * la diferencia con borrar no es de estilo: `auditoria_log` (0010) tiene que
 * conservar la fila para que se vea que existo una factura y por que se
 * cancelo. Un DELETE de una factura emitida deja el mismo hueco que deja
 * borrar una nota de remision, y ese hueco es un problema con el SAT.
 *
 * La ruta del cambio pide `facturas.solicitar` y el servicio pide
 * `facturas.emitir` aparte cuando la transicion es a `emitida` o a
 * `cancelada`. Ver la nota de `cambiarEstatus` en el servicio, que explica
 * por que esa comprobacion no puede vivir en el trigger.
 */
export const rutasFacturacion = Router();

rutasFacturacion.use(requiereSesion);

rutasFacturacion.get(
  '/',
  requierePermiso('facturas.ver'),
  validarQuery(listarFacturasEsquema),
  controlador.listar,
);

rutasFacturacion.get(
  '/:id',
  requierePermiso('facturas.ver'),
  validarParams(idFacturaEsquema),
  controlador.consultar,
);

rutasFacturacion.post(
  '/',
  requierePermiso('facturas.solicitar'),
  validarBody(crearFacturaEsquema),
  controlador.crear,
);

rutasFacturacion.patch(
  '/:id/estatus',
  requierePermiso('facturas.solicitar'),
  validarParams(idFacturaEsquema),
  validarBody(cambiarEstatusEsquema),
  controlador.cambiarEstatus,
);
