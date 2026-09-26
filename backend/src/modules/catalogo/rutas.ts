import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams } from '../../core/validacion.js';
import { crearCatalogoEsquema, idCatalogoEsquema, renombrarCatalogoEsquema } from './esquemas.js';
import { controladorCatalogo } from './controlador.js';
import type { ClaveRecurso } from './repositorio.js';

/**
 * Rutas del catalogo: /api/especies y /api/categorias-producto.
 *
 * Las dos se construyen con una funcion porque el recurso solo cambia en
 * tres cosas: el permiso, la tabla y los mensajes. El resto del camino
 * (validar, autorizar, ejecutar) es identico, y duplicarlo seria dos
 * copias que se van a desincronizar.
 *
 * A diferencia de /api/usuarios, aqui NO todo es de admin: leer el
 * catalogo es necesario para vender, asi que va por permiso granular
 * (`especies.ver`, `categorias.ver`) y la migracion 0003 se lo da a los
 * tres roles. Escribir y borrar si son solo del admin.
 */
export const rutasCatalogo: Record<ClaveRecurso, Router> = {
  especies: construir('especies', 'especies'),
  categorias: construir('categorias', 'categorias'),
};

function construir(clave: ClaveRecurso, moduloPermiso: string): Router {
  const router = Router();
  const ctrl = controladorCatalogo(clave);

  router.use(requiereSesion);

  router.get('/', requierePermiso(`${moduloPermiso}.ver`), ctrl.listar);
  router.get(
    '/:id',
    requierePermiso(`${moduloPermiso}.ver`),
    validarParams(idCatalogoEsquema),
    ctrl.obtener,
  );
  router.post(
    '/',
    requierePermiso(`${moduloPermiso}.crear`),
    validarBody(crearCatalogoEsquema),
    ctrl.crear,
  );
  router.put(
    '/:id',
    requierePermiso(`${moduloPermiso}.editar`),
    validarParams(idCatalogoEsquema),
    validarBody(renombrarCatalogoEsquema),
    ctrl.renombrar,
  );
  router.delete(
    '/:id',
    requierePermiso(`${moduloPermiso}.eliminar`),
    validarParams(idCatalogoEsquema),
    ctrl.borrar,
  );

  return router;
}
