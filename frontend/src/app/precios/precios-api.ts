import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { decimalComoTexto } from '../nucleo/cifras';

/**
 * El servicio de precios.
 *
 * Los tipos son un espejo de `precios/modelo.ts`. Es el módulo con la forma
 * MÁS distinta de las que se han hecho:
 *
 *   - DOS recursos en vez de uno: `precios_publicos` (el precio de lista del
 *     producto) y `precios_cliente` (lo pactado con una persona). No son el
 *     mismo dato y no se mezclan; el menú ofrece "Precios" y la pantalla
 *     separa las dos vistas.
 *   - NO hay borrar: un precio borrado es un hueco en la historia de
 *     facturación, y las notas guardan el precio que se leyó al cobrar.
 *     "Borrar" es cerrarlo, que le pone la fecha de fin y deja la fila.
 *   - La actualización es PARCIAL y `vigente_hasta: null` significa "abrir de
 *     nuevo" (no "no lo mandes").
 *   - La vigencia es lo que vale: los precios se traslapan o no por fechas, y
 *     el sistema rechaza un rango que choca con otro (`VIGENCIA_*`) o que
 *     termina antes de empezar.
 */

// --------------------------------------------------------------------- tipos

/** `precios/modelo.ts` -> `PrecioPublico`. */
export interface PrecioPublico {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  precio_kg: number;
  vigente_desde: string;
  vigente_hasta: string | null;
}

/** `precios/modelo.ts` -> `PrecioCliente`. Es el público con cliente. */
export interface PrecioCliente {
  id: number;
  cliente_id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  cliente_nombre: string;
  precio_kg: number;
  vigente_desde: string;
  vigente_hasta: string | null;
}

/** La envoltura de los listados, igual que productos y usuarios. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** Lo que se puede preguntar del listado. Los filtros van sobre el recurso. */
export interface Criterios {
  /** Un producto en concreto: la línea de tiempo completa de su precio. */
  producto_id?: number;
  /** Un cliente en concreto, solo en el listado de precios de cliente. */
  cliente_id?: number;
  vigencia?: Vigencia;
  limite?: number;
  offset?: number;
}

export type Vigencia = 'todos' | 'vigentes' | 'historicos';

/** Un cliente o producto para los selectores del editor. */
export interface OpcionFiltro {
  id: number;
  codigo: string;
  nombre: string;
}

/** La forma que saca el editor: producto o cliente según el recurso. */
export interface PrecioNuevoBase {
  precio_kg: string;
  vigente_desde: string;
  vigente_hasta: string;
}

// ------------------------------------------------------------- el cuerpo
/**
 * Los datos de un precio, sea alta o actualización.
 *
 * `vigente_hasta` vacío va siempre como `null` ("abierto"), nunca omitido: en
 * el alta los dos valen, y al actualizar es justo lo que reabre un precio
 * cerrado. Mandarlo explícito quita la distinción que el sistema distingue
 * — `undefined` es "no tocar" y `null` es "abrir" — y la pantalla siempre sabe
 * cuál de las dos quiere.
 *
 * El `precio_kg` se normaliza con `decimalComoTexto` exactamente como el punto
 * de venta normaliza el monto del pago: el campo es un número con dos
 * decimales y las reglas de validación no admiten una coma ni ceros de más.
 */
export interface CuerpoPrecio {
  precio_kg: string;
  vigente_desde: string;
  vigente_hasta: string | null;
}

export function cuerpoDePrecio(precioKg: string, desde: string, hasta: string): CuerpoPrecio {
  const limpia = hasta.trim();
  return {
    precio_kg: decimalComoTexto(precioKg, 2),
    vigente_desde: desde,
    vigente_hasta: limpia === '' ? null : limpia,
  };
}

/** Por qué una vigencia no se puede guardar, o null si está lista. */
export function problemaDeVigencia(desde: string, hasta: string): string | null {
  if (desde.trim() === '') return 'La vigencia necesita una fecha de inicio.';
  if (hasta.trim() !== '' && hasta < desde) {
    return 'La vigencia no puede terminar antes de empezar.';
  }
  return null;
}

/** El precio como texto que se le puede mandar a las reglas de validación, o null si no. */
export function problemaDePrecio(texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === '') return null;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(limpio.replace(',', '.'))) {
    return 'El precio debe ser un número con hasta 2 decimales.';
  }
  if (Number(limpio.replace(',', '.')) < 0) return 'El precio no puede ser negativo.';
  return null;
}

/** La fecha de hoy en el formato que esperan las reglas de validación (AAAA-MM-DD). */
export function hoyComoTexto(fecha = new Date()): string {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

// ----------------------------------------------------------------- llamadas

@Injectable({ providedIn: 'root' })
export class PreciosApi {
  private readonly http = inject(HttpClient);

  /** Busca productos por código o nombre, para el selector del editor. */
  async productos(buscar: string): Promise<OpcionFiltro[]> {
    if (buscar.trim().length < 1) return [];
    const respuesta = await firstValueFrom(
      this.http.get<Listado<{ id: number; codigo: string; nombre: string }>>(`${API}/productos`, {
        params: { buscar: buscar.trim(), limite: 20 },
      }),
    );
    return respuesta.datos;
  }

  /** Busca clientes por nombre, para el selector del editor. */
  async clientes(buscar: string): Promise<OpcionFiltro[]> {
    if (buscar.trim().length < 2) return [];
    const respuesta = await firstValueFrom(
      this.http.get<Listado<{ id: number; nombre: string; codigo?: string | null }>>(
        `${API}/clientes`,
        { params: { buscar: buscar.trim(), limite: 20 } },
      ),
    );
    return respuesta.datos.map((c) => ({
      id: c.id,
      codigo: c.codigo ?? '',
      nombre: c.nombre,
    }));
  }

  /** El precio de lista: el que se deduce del producto. */
  async listarPublicos(criterios: Criterios): Promise<Listado<PrecioPublico>> {
    return firstValueFrom(
      this.http.get<Listado<PrecioPublico>>(`${API}/precios/publicos`, {
        params: paramsDe(criterios),
      }),
    );
  }

  /** El precio pactado con un cliente en concreto. */
  async listarClientes(criterios: Criterios): Promise<Listado<PrecioCliente>> {
    return firstValueFrom(
      this.http.get<Listado<PrecioCliente>>(`${API}/precios/clientes`, {
        params: paramsDe(criterios),
      }),
    );
  }

  async crearPublico(cuerpo: CuerpoPrecio, productoId: number): Promise<PrecioPublico> {
    return firstValueFrom(
      this.http.post<PrecioPublico>(`${API}/precios/publicos`, {
        producto_id: productoId,
        ...cuerpo,
      }),
    );
  }

  async crearCliente(
    cuerpo: CuerpoPrecio,
    clienteId: number,
    productoId: number,
  ): Promise<PrecioCliente> {
    return firstValueFrom(
      this.http.post<PrecioCliente>(`${API}/precios/clientes`, {
        cliente_id: clienteId,
        producto_id: productoId,
        ...cuerpo,
      }),
    );
  }

  async actualizarPublico(id: number, cuerpo: CuerpoPrecio): Promise<PrecioPublico> {
    return firstValueFrom(this.http.patch<PrecioPublico>(`${API}/precios/publicos/${id}`, cuerpo));
  }

  async actualizarCliente(id: number, cuerpo: CuerpoPrecio): Promise<PrecioCliente> {
    return firstValueFrom(this.http.patch<PrecioCliente>(`${API}/precios/clientes/${id}`, cuerpo));
  }

  /** Cierra un precio: le pone la fecha de fin. No se borra, se cierra. */
  async cerrarPublico(id: number, vigenteHasta: string): Promise<PrecioPublico> {
    return firstValueFrom(
      this.http.post<PrecioPublico>(`${API}/precios/publicos/${id}/cerrar`, {
        vigente_hasta: vigenteHasta,
      }),
    );
  }

  async cerrarCliente(id: number, vigenteHasta: string): Promise<PrecioCliente> {
    return firstValueFrom(
      this.http.post<PrecioCliente>(`${API}/precios/clientes/${id}/cerrar`, {
        vigente_hasta: vigenteHasta,
      }),
    );
  }

  /** Exporta los precios de lista (públicos) a Excel. */
  async exportarExcelPublicos(criterios: Criterios): Promise<void> {
    const params = paramsDe(criterios);
    const resp = await firstValueFrom(
      this.http.get(`${API}/precios/publicos/exportar`, {
        params,
        responseType: 'blob',
        observe: 'response',
      }),
    );
    const blob = resp.body!;
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'precios-lista.xlsx';
    a.click();
    window.URL.revokeObjectURL(url);
  }

  /** Exporta los precios de cliente a Excel. */
  async exportarExcelClientes(criterios: Criterios): Promise<void> {
    const params = paramsDe(criterios);
    const resp = await firstValueFrom(
      this.http.get(`${API}/precios/clientes/exportar`, {
        params,
        responseType: 'blob',
        observe: 'response',
      }),
    );
    const blob = resp.body!;
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'precios-cliente.xlsx';
    a.click();
    window.URL.revokeObjectURL(url);
  }
}

/**
 * Los datos que se mandan al consultar una vista, quitando lo que esa vista no
 * acepta.
 *
 * Existe por el `cliente_id`. Los dos listados validan lo que reciben
 * (`precios/esquemas.ts`): el de precios de lista NO tiene `cliente_id` entre
 * sus campos, así que mandárselo no lo ignora, lo rechaza con un 400 y deja la
 * pantalla en blanco. Antes se armaba un solo objeto de criterios con
 * `cliente_id` puesto siempre que hubiera filtro de cliente, y como ese filtro
 * no se quitaba al cambiar de pestaña, filtrar por un cliente y pasar a
 * "Precio de lista" rompía el listado.
 *
 * Aquí se decide por vista, que es donde se sabe qué campo manda cada una.
 *
 * El `offset` sale de la página y del límite, no se pasa: un número de página
 * guardado sería un `offset` guardado, que envejece en cuanto cambia el
 * filtro.
 */
export function criteriosDe(
  vista: 'publicos' | 'clientes',
  filtros: {
    productoId?: number;
    clienteId?: number;
    vigencia: Vigencia;
    /**
     * Opcionales a propósito: el listado los necesita, la exportación no.
     *
     * Sin ellos no se manda `limite` ni `offset` y el sistema exporta todo lo
     * que encaja en el filtro (`listarTodosPublicos`, que quita la
     * paginación). Un Excel con los 50 de la página parece completo y no lo
     * está, que es peor que no exportar.
     */
    limite?: number;
    pagina?: number;
  },
): Criterios {
  const criterios: Criterios = { vigencia: filtros.vigencia };
  if (filtros.limite !== undefined) criterios.limite = filtros.limite;
  if (filtros.limite !== undefined && filtros.pagina !== undefined) {
    criterios.offset = (filtros.pagina - 1) * filtros.limite;
  }
  if (filtros.productoId !== undefined) criterios.producto_id = filtros.productoId;
  if (vista === 'clientes' && filtros.clienteId !== undefined) {
    criterios.cliente_id = filtros.clienteId;
  }
  return criterios;
}

/** Los criterios que sí van, y la vigencia siempre para que el sistema decida. */
function paramsDe(criterios: Criterios): Record<string, string | number> {
  const params: Record<string, string | number> = {
    limite: criterios.limite ?? 50,
    offset: criterios.offset ?? 0,
    vigencia: criterios.vigencia ?? 'vigentes',
  };
  if (criterios.producto_id !== undefined) params['producto_id'] = criterios.producto_id;
  if (criterios.cliente_id !== undefined) params['cliente_id'] = criterios.cliente_id;
  return params;
}
