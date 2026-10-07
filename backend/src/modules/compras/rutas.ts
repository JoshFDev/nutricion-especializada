import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  cancelarCompraEsquema,
  crearCompraEsquema,
  idCompraEsquema,
  listarComprasEsquema,
} from './esquemas.js';
import { controladorCompras as controlador } from './controlador.js';

/**
 * Rutas de compras.
 *
 * No hay PATCH, y es a proposito: una compra ya escrita se deshace
 * cancelandola, no editando sus renglones. Editarlos dejaria el inventario
 * con la entrada vieja y la nueva, y `fn_sincronizar_inventario_compra`
 * tendria que adivinar cual de las dos vale.
 *
 * La cancelacion pide `compras.crear` y no un permiso nuevo, porque el
 * trigger `trg_permiso_compras` (0001) exige `compras.crear` tambien en el
 * UPDATE. Si la ruta exigiera otra cosa, el service devolveria 403 y la base
 * 42501: dos reglas para lo mismo, y la mas cercana de las dos (la de la
 * ruta) seria la que no manda.
 */
export const rutasCompras = Router();

rutasCompras.use(requiereSesion);

/**
 * Leer compras exige `compras.ver` y escribirlas `compras.crear`, igual que
 * pagos con `pagos.ver`/`pagos.crear`. Tener sesion no es tener permiso.
 */

rutasCompras.get(
  '/',
  requierePermiso('compras.ver'),
  validarQuery(listarComprasEsquema),
  controlador.listar,
);

rutasCompras.get(
  '/:id',
  requierePermiso('compras.ver'),
  validarParams(idCompraEsquema),
  controlador.consultar,
);

rutasCompras.post(
  '/',
  requierePermiso('compras.crear'),
  validarBody(crearCompraEsquema),
  controlador.crear,
);

rutasCompras.post(
  '/:id/cancelar',
  requierePermiso('compras.crear'),
  validarParams(idCompraEsquema),
  validarBody(cancelarCompraEsquema),
  controlador.cancelar,
);

/**
 * Pagar usa `compras.crear` por el mismo motivo que la cancelacion: el
 * permiso que la base ya exige para tocar una compra. `pagos_proveedor` no
 * tiene trigger de permiso (no existia API para escribirlo), asi que la regla
 * queda en la ruta: sin `compras.crear` no se mueve dinero de la compra.
 *
 * No lleva cuerpo: el abono es por EXACTAMENTE lo que falta, y el monto lo
 * calcula la base para que el saldo del proveedor no se pase de ceros.
 */
rutasCompras.post(
  '/:id/pagar',
  requierePermiso('compras.crear'),
  validarParams(idCompraEsquema),
  controlador.pagar,
);
