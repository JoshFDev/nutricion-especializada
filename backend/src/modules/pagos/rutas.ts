import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import { crearPagoEsquema, idPagoEsquema, listarPagosEsquema } from './esquemas.js';
import { controladorPagos as controlador } from './controlador.js';

/**
 * Rutas de cobranza.
 *
 * No hay DELETE ni PATCH, y no es un hueco: un pago es un documento que se
 * puede dejar sin aplicar (un abono a cuenta) o aplicar a otra nota, pero
 * no se borra ni se corrige en silencio. Un pago mal capturado se cancela
 * mirando que la nota que cubria se cancele, y queda el rastro.
 *
 * Los GET llevan `pagos.ver` y el POST `pagos.crear`, igual que notas con
 * `notas.ver` y `notas.crear`: tener sesion no es tener permiso. Los tres
 * roles tienen los dos, asi que hoy la diferencia no se nota, pero deja de
 * ser un permiso decorativo el dia que se abra o se cierre a alguien.
 */
export const rutasPagos = Router();

rutasPagos.use(requiereSesion);

rutasPagos.get(
  '/',
  requierePermiso('pagos.ver'),
  validarQuery(listarPagosEsquema),
  controlador.listar,
);

rutasPagos.get(
  '/:id',
  requierePermiso('pagos.ver'),
  validarParams(idPagoEsquema),
  controlador.consultar,
);

rutasPagos.post(
  '/',
  requierePermiso('pagos.crear'),
  validarBody(crearPagoEsquema),
  controlador.crear,
);
