import { Router } from 'express';
import { requierePermiso, requiereSesion } from '../../middleware/permisos.js';
import { validarBody, validarParams, validarQuery } from '../../core/validacion.js';
import {
  cierreEsquema,
  crearCuentaEsquema,
  crearMovimientoEsquema,
  idCuentaEsquema,
  idMovimientoEsquema,
  listarCuentasEsquema,
  listarCategoriasEsquema,
  listarMovimientosEsquema,
  resumenEsquema,
} from './esquemas.js';
import { controladorCaja as controlador } from './controlador.js';

/**
 * Rutas de caja y bancos.
 *
 * El DELETE es el unico de todo el proyecto, y el permiso que lo guarda
 * (`caja.eliminar`) existe desde 0001 justamente para esto: el trigger
 * `trg_permiso_mov_fin` mapea INSERT y UPDATE a `caja.capturar` y DELETE a
 * `caja.eliminar`, o sea que el borrado de un movimiento se autorizo
 * siempre a proposito. En los demas modulos no hay DELETE porque alli el
 * registro tiene nombre y aparece en documentos viejos; un movimiento de
 * caja solo existe en `auditoria_caja`. Ver la nota de `servicio.ts`.
 *
 * El alta de CUENTA pide `caja.capturar` y no un permiso propio, por el
 * mismo motivo que proveedores: la tabla de permisos (0001) no tiene
 * `caja.editar`, y agregar uno para darlo solo al admin dejaria a la Cajera
 * -- que es la que maneja caja y bancos -- sin poder abrir la cuenta del
 * banco nuevo. Es la unica operacion de este modulo que no la hacen todos
 * los dias, asi que el riesgo es pequeno y el beneficio de no inventar
 * permisos es real.
 *
 * `GET /resumen` existe porque las sumas no se pueden calcular en el
 * frontend: el listado viene paginado, y un `total` de la pagina no es el
 * total del periodo. El resumen es la unica forma de que "hoy entrare X"
 * sea un numero correcto y no la suma de lo que se alcanzo a ver.
 */
export const rutasCaja = Router();

rutasCaja.use(requiereSesion);

// ---------------------------------------------------------------- cuentas
rutasCaja.get(
  '/cuentas',
  requierePermiso('caja.ver'),
  validarQuery(listarCuentasEsquema),
  controlador.listarCuentas,
);

rutasCaja.get(
  '/cuentas/:id',
  requierePermiso('caja.ver'),
  validarParams(idCuentaEsquema),
  controlador.consultarCuenta,
);

rutasCaja.post(
  '/cuentas',
  requierePermiso('caja.capturar'),
  validarBody(crearCuentaEsquema),
  controlador.crearCuenta,
);

// -------------------------------------------------------------- movimientos
rutasCaja.get(
  '/movimientos',
  requierePermiso('caja.ver'),
  validarQuery(listarMovimientosEsquema),
  controlador.listarMovimientos,
);

rutasCaja.get(
  '/movimientos/:id',
  requierePermiso('caja.ver'),
  validarParams(idMovimientoEsquema),
  controlador.consultarMovimiento,
);

rutasCaja.post(
  '/movimientos',
  requierePermiso('caja.capturar'),
  validarBody(crearMovimientoEsquema),
  controlador.crearMovimiento,
);

rutasCaja.delete(
  '/movimientos/:id',
  requierePermiso('caja.eliminar'),
  validarParams(idMovimientoEsquema),
  controlador.eliminarMovimiento,
);

// ------------------------------------------------------------------ extras
rutasCaja.get(
  '/resumen',
  requierePermiso('caja.ver'),
  validarQuery(resumenEsquema),
  controlador.resumen,
);

/**
 * El arqueo esperado de un dia.
 *
 * Es de solo lectura y usa `caja.ver`, como el resumen: ver cuanto deberia
 * haber en caja no es capturar ni borrar nada, y quien puede ver los
 * movimientos ya puede hacer esta suma. No se invento un `caja.cerrar` por la
 * misma razon que el alta de cuenta no tiene permiso propio: un permiso nuevo
 * solo para el admin dejaria a la cajera sin poder cerrar su propio turno.
 */
rutasCaja.get(
  '/cierre',
  requierePermiso('caja.ver'),
  validarQuery(cierreEsquema),
  controlador.cierre,
);

rutasCaja.get(
  '/categorias',
  requierePermiso('caja.ver'),
  validarQuery(listarCategoriasEsquema),
  controlador.listarCategorias,
);
