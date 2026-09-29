import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * La API de inventario.
 *
 * Es el espejo de `backend/src/modules/inventario`, y es el modulo mas chico
 * de la API: UNA ruta de SOLO LECTURA. Ajustar y registrar merma ya existen
 * como permisos y como triggers (`inventario.ajustar`, `inventario.merma`),
 * pero ningun endpoint las expone a proposito: escriben en
 * `auditoria_inventario` con el antes y el despues y necesitan un motivo
 * obligatorio, y eso quiere su propia pantalla, no un endpoint colado aqui.
 *
 * Lo que se lee es la EXISTENCIA por producto y almacen, y no hay tabla de
 * saldos: es la SUMA de `inventario_movimientos` (`fn_existencia_de`). Las
 * notas de venta y las compras ya mueven esos movimientos por trigger, asi
 * que esta pantalla no escribe nada. Un producto que nunca se compro aparece
 * en cero, no desaparece del reporte: el repositorio cruza productos por
 * almacenes.
 */

// --------------------------------------------------------------------- tipos

/** `inventario/modelo.ts` -> `Existencia`. La existencia es en BULTOS. */
export interface Existencia {
  producto_id: number;
  producto_codigo: string;
  producto: string;
  almacen_id: number;
  almacen: string;
  /** En bultos, que es la unidad con la que se compra y se vende. */
  existencia_bultos: number;
  producto_activo: boolean;
}

/** La envoltura del listado (`inventario/servicio.ts`), como productos. */
export interface ListaExistencia {
  datos: Existencia[];
  total: number;
  limite: number;
  offset: number;
}

/**
 * Que renglones se quieren ver.
 *
 * El backend solo sabe decir `vacios=true` (en cero o negativo) o
 * `vacios=false` (con existencia), y "todas" es no mandar el parametro. Esta
 * pantalla traduce los tres estados a esos dos casos.
 */
export type FiltroExistencia = 'todas' | 'con' | 'vacios';

/** Lo que se le puede pedir a la lista. */
export interface OpcionesExistencia {
  buscar?: string;
  producto_id?: number;
  almacen_id?: number;
  existencia?: FiltroExistencia;
  limite?: number;
  offset?: number;
}

/**
 * Los parametros de la peticion, aparte de la llamada.
 *
 * Va como funcion pura y exportada para poder probarla: el esquema del
 * backend es `strict` y un parametro de mas da un 400, asi que "que se manda
 * y que no" es la parte del contrato que conviene tener cubierta. "Todas" no
 * manda `vacios`; "con" y "vacios" mandan el `'true'`/`'false'` que el
 * esquema convierte a booleano.
 */
export function parametrosDe(opciones: OpcionesExistencia): Record<string, string | number> {
  const params: Record<string, string | number> = {
    limite: opciones.limite ?? 50,
    offset: opciones.offset ?? 0,
  };
  if (opciones.buscar) params['buscar'] = opciones.buscar;
  if (opciones.producto_id !== undefined) params['producto_id'] = opciones.producto_id;
  if (opciones.almacen_id !== undefined) params['almacen_id'] = opciones.almacen_id;
  if (opciones.existencia === 'con') params['vacios'] = 'false';
  if (opciones.existencia === 'vacios') params['vacios'] = 'true';
  return params;
}

// --------------------------------------------------------------- las llamadas

@Injectable({ providedIn: 'root' })
export class InventarioApi {
  private readonly http = inject(HttpClient);

  /** Lista la existencia con busqueda y filtro. */
  async listar(opciones: OpcionesExistencia): Promise<ListaExistencia> {
    return firstValueFrom(
      this.http.get<ListaExistencia>(`${API}/inventario/existencia`, {
        params: parametrosDe(opciones),
      }),
    );
  }
}
