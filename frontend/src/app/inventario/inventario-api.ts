import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * La API de inventario.
 *
 * Es el espejo de `backend/src/modules/inventario`. Dos familias:
 *
 *   - La EXISTENCIA por producto y almacen, de solo lectura. No hay tabla de
 *     saldos: es la SUMA de `inventario_movimientos` (`fn_existencia_de`).
 *     Las notas de venta y las compras mueven esos movimientos por trigger.
 *     Un producto que nunca se compro aparece en cero, no desaparece.
 *
 *   - Los MOVIMIENTOS manuales: registrar un ajuste o una merma y borrarlos.
 *     El alta necesita motivo y el permiso `inventario.ajustar` (el mismo que
 *     el trigger de la base pide); el borrado queda en `auditoria_inventario`
 *     con el antes y el despues. El listado de movimientos es el KARDEX: trae
 *     tambien los de compra y venta, para que la historia del bulto se lea de
 *     una sola pasada. Solo los manuales se pueden borrar, y el backend lo
 *     comprueba.
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

// ------------------------------------------------------------------ el kardex

/** `inventario/modelo.ts` -> `Movimiento`. La cantidad SIEMPRE es positiva. */
export interface Movimiento {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto: string;
  almacen_id: number;
  almacen: string;
  /** "AAAA-MM-DDThh:mm", sin zona: es hora local del servidor. */
  fecha: string;
  tipo: 'entrada_compra' | 'salida_venta' | 'ajuste_positivo' | 'ajuste_negativo' | 'merma';
  /** Cantidad POSITIVA; el signo lo dice el tipo (`firmaDe`). */
  cantidad_bultos: number;
  motivo: string | null;
  /** Solo los manuales (ajuste o merma) se pueden borrar. */
  manual: boolean;
  creado_en: string;
}

export interface ListaMovimientos {
  datos: Movimiento[];
  total: number;
  limite: number;
  offset: number;
}

/** Lo que se puede pedir del kardex: esta pantalla siempre manda producto y almacen. */
export interface OpcionesMovimientos {
  producto_id: number;
  almacen_id: number;
  tipo?: Movimiento['tipo'];
  limite?: number;
  offset?: number;
}

/** Lo que se manda al registrar un ajuste o una merma. */
export interface NuevoMovimiento {
  producto_id: number;
  almacen_id: number;
  tipo: 'ajuste_positivo' | 'ajuste_negativo' | 'merma';
  cantidad_bultos: string;
  motivo: string;
}

/** Lo que pide el kardex, aparte de producto y almacen. Ver `parametrosDe`. */
export function parametrosDeMovimientos(
  opciones: OpcionesMovimientos,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    producto_id: opciones.producto_id,
    almacen_id: opciones.almacen_id,
    limite: opciones.limite ?? 50,
    offset: opciones.offset ?? 0,
  };
  if (opciones.tipo !== undefined) params['tipo'] = opciones.tipo;
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

  /** El kardex de un producto en un almacen, del mas reciente al mas viejo. */
  async listarMovimientos(opciones: OpcionesMovimientos): Promise<ListaMovimientos> {
    return firstValueFrom(
      this.http.get<ListaMovimientos>(`${API}/inventario/movimientos`, {
        params: parametrosDeMovimientos(opciones),
      }),
    );
  }

  /** Registra un ajuste o una merma. Pide `inventario.ajustar`. */
  async crearMovimiento(nuevo: NuevoMovimiento): Promise<Movimiento> {
    return firstValueFrom(this.http.post<Movimiento>(`${API}/inventario/movimientos`, nuevo));
  }

  /** Borra un movimiento MANUAL. Los de compra/venta se rechazan. */
  async eliminarMovimiento(id: number): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${API}/inventario/movimientos/${id}`));
  }
}
