import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  actualizarProductoEsquema,
  crearProductoEsquema,
  idProductoEsquema,
  listarProductosEsquema,
} from './esquemas.js';
import { controladorProductos } from './controlador.js';

/**
 * Rutas de /api/productos.
 *
 * A diferencia de /api/usuarios, aqui no todo es de admin: ver el catalogo
 * de productos es necesario para vender, asi que va por permiso granular.
 * Los permisos `productos.ver` y `productos.editar` ya vienen de la
 * migracion 0001 con este reparto: Administrador edita, Empleada lee, y la
 * Cajera no entra. Por eso este modulo no necesita migracion de permisos
 * como si la necesitaran especies y categorias.
 *
 * Escrituras con PATCH y no con PUT: el formulario de edicion manda los
 * campos que cambian y listo, sin tener que reenviar nombre y codigo en
 * cada ajuste de precio. Mismo criterio que usuarios.
 *
 * DELETE es borrado FISICO y solo funciona en productos sin historial.
 * Un producto que ya se vendio se da de baja con PATCH { "activo": false },
 * y el servicio explica la diferencia cuando alguien intenta borrarlo.
 */
export const rutasProductos = Router();

const ctrl = controladorProductos;

rutasProductos.use(requiereSesion);

rutasProductos.get(
  '/',
  requierePermiso('productos.ver'),
  validarQuery(listarProductosEsquema),
  ctrl.listar,
);

rutasProductos.get(
  '/:id',
  requierePermiso('productos.ver'),
  validarParams(idProductoEsquema),
  ctrl.obtener,
);

rutasProductos.post(
  '/',
  requierePermiso('productos.editar'),
  validarBody(crearProductoEsquema),
  ctrl.crear,
);

rutasProductos.patch(
  '/:id',
  requierePermiso('productos.editar'),
  validarParams(idProductoEsquema),
  validarBody(actualizarProductoEsquema),
  ctrl.actualizar,
);

rutasProductos.delete(
  '/:id',
  requierePermiso('productos.editar'),
  validarParams(idProductoEsquema),
  ctrl.borrar,
);

rutasProductos.get(
  '/exportar/excel',
  requierePermiso('productos.ver'),
  validarQuery(listarProductosEsquema),
  ctrl.exportarExcel,
);
