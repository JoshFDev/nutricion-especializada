import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  actualizarPrecioClienteEsquema,
  actualizarPrecioPublicoEsquema,
  crearPrecioClienteEsquema,
  crearPrecioPublicoEsquema,
  cerrarPrecioEsquema,
  idPrecioEsquema,
  listarPreciosClienteEsquema,
  listarPreciosPublicosEsquema,
  precioEfectivoEsquema,
} from './esquemas.js';
import { controladorPrecios } from './controlador.js';

/**
 * Rutas de /api/precios.
 *
 * `precios.ver` y `precios.editar` ya vienen de la migracion 0001 con este
 * reparto: Administrador y Cajera editan, Empleada lee. No hace falta
 * migracion de permisos como si la necesitaran especies y categorias.
 *
 * Ojo con el reparto, que cambio despues: 0006 le dio a Cajera 38 de los 43
 * permisos (le quedaron fuera los cinco de `auditoria.*` que nadie mas
 * necesita), y entre los regalados estan los dos de precios. Este comentario
 * dizia "Cajera no entra" porque se copio del modulo de productos, donde si
 * es cierto. Aqui la cajera cobra en la caja y es la que consulta el precio
 * del producto justo antes de cobrarlo, asi que dejarla fuera de la lectura
 * la obligaria a pedirle el numero a otra persona en cada venta. Un permiso
 * que se justifica con una frase vieja y no con el trabajo de la persona
 * termina alguien pagandolo en un malentendido.
 *
 * Dos subrutas porque hay dos tablas con vida propia: `precios_publicos` es
 * el precio de lista del producto y `precios_cliente` es lo pactado con
 * una persona. No se mezclan en un recurso con un `tipo` porque no son el
 * mismo dato: el publico se deduce del producto y el especial no, y una
 * pantalla de "precios" que tuviera las dos filas revueltas obligaria al
 * frontend a filtrar por un campo que en la base no existe.
 *
 * NO HAY DELETE en ninguna de las dos. Un precio borrado es un hueco en la
 * historia de facturacion: las notas de remision guardan el precio que se
 * leyo al cobrar, y sin la fila ya no se puede reconstruir de donde salio
 * ese numero. En su lugar esta `POST /:id/cerrar`, que le pone fecha de
 * fin. El comentario de 0001 sobre `precios_cliente` ya lo decia asi.
 *
 * `GET /efectivo` va antes que los `/:id` para que Express no lo confunda
 * con un id: sin ese orden, "efectivo" pasaria por validarParams y
 * contestaria un 400 de "el id debe ser un numero positivo" en vez de
 * devolver el precio. Es el mismo motivo por el que catalogo declara sus
 * rutas literales antes que las de recurso.
 */
export const rutasPrecios = Router();

const ctrl = controladorPrecios;

rutasPrecios.use(requiereSesion);

// El precio que toca cobrar. Sin esto, la cajera tendria que traer los dos
// listados, cruzarlos en el cliente y decidir cual gana — y cada cliente del
// frontend resolveria la precedencia a su manera.
rutasPrecios.get(
  '/efectivo',
  requierePermiso('precios.ver'),
  validarQuery(precioEfectivoEsquema),
  ctrl.efectivo,
);

rutasPrecios.get(
  '/publicos',
  requierePermiso('precios.ver'),
  validarQuery(listarPreciosPublicosEsquema),
  ctrl.listarPublicos,
);

rutasPrecios.get(
  '/clientes',
  requierePermiso('precios.ver'),
  validarQuery(listarPreciosClienteEsquema),
  ctrl.listarClientes,
);

rutasPrecios.post(
  '/publicos',
  requierePermiso('precios.editar'),
  validarBody(crearPrecioPublicoEsquema),
  ctrl.crearPublico,
);

rutasPrecios.post(
  '/clientes',
  requierePermiso('precios.editar'),
  validarBody(crearPrecioClienteEsquema),
  ctrl.crearCliente,
);

rutasPrecios.get(
  '/publicos/:id',
  requierePermiso('precios.ver'),
  validarParams(idPrecioEsquema),
  ctrl.obtenerPublico,
);

rutasPrecios.get(
  '/clientes/:id',
  requierePermiso('precios.ver'),
  validarParams(idPrecioEsquema),
  ctrl.obtenerCliente,
);

rutasPrecios.patch(
  '/publicos/:id',
  requierePermiso('precios.editar'),
  validarParams(idPrecioEsquema),
  validarBody(actualizarPrecioPublicoEsquema),
  ctrl.actualizarPublico,
);

rutasPrecios.patch(
  '/clientes/:id',
  requierePermiso('precios.editar'),
  validarParams(idPrecioEsquema),
  validarBody(actualizarPrecioClienteEsquema),
  ctrl.actualizarCliente,
);

rutasPrecios.post(
  '/publicos/:id/cerrar',
  requierePermiso('precios.editar'),
  validarParams(idPrecioEsquema),
  validarBody(cerrarPrecioEsquema),
  ctrl.cerrarPublico,
);

rutasPrecios.post(
  '/clientes/:id/cerrar',
  requierePermiso('precios.editar'),
  validarParams(idPrecioEsquema),
  validarBody(cerrarPrecioEsquema),
  ctrl.cerrarCliente,
);
