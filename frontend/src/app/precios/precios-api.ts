import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { decimalComoTexto } from '../nucleo/cifras';

/**
 * La API de precios.
 *
 * Tipos espejo de `backend/src/modules/precios`. Es el modulo con la forma
 * MAS distinta de las que se han hecho:
 *
 *   - DOS recursos en vez de uno: `precios_publicos` (el precio de lista
 *     del producto) y `precios_cliente` (lo pactado con una persona). No
 *     son el mismo dato y no se mezclan; el menu ofrece "Precios" y la
 *     pantalla separa las dos vistas.
 *   - NO hay DELETE: un precio borrado es un hueco en la historia de
 *     facturacion, y las notas guardan el precio que se leyo al cobrar.
 *     "Borrar" es cerrarlo con `POST /:id/cerrar`, que le pone la fecha de
 *     fin y deja la fila.
 *   - El PATCH es PARCIAL y `vigente_hasta: null` significa "abrir de
 *     nuevo" (no "no lo mandes").
 *   - La vigencia es lo que vale: los precios se traslapan o no por fechas,
 *     y el backend rechaza un rango que choca con otro (`VIGENCIA_*`) o que
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

/** `precios/modelo.ts` -> `PrecioCliente`. Es el publico con cliente. */
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
  /** Un producto en concreto: la linea de tiempo completa de su precio. */
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

/** La forma que saca el editor: producto o cliente segun el recurso. */
export interface PrecioNuevoBase {
  precio_kg: string;
  vigente_desde: string;
  vigente_hasta: string;
}

// ------------------------------------------------------------- el cuerpo
/**
 * El cuerpo de un precio, sea alta o actualizacion.
 *
 * `vigente_hasta` vacio va siempre como `null` ("abierto"), nunca omitido:
 * en el alta los dos valen, y en el PATCHes justo lo que reabre un precio
 * cerrado. Mandarlo explícito quita la distincion que el backend distingue
 * — `undefined` es "no tocar" y `null` es "abrir" — y la pantalla siempre
 * sabe cuál de las dos quiere.
 *
 * El `precio_kg` se normaliza con `decimalComoTexto` exactamente como el
 * POS normaliza el monto del pago: la base es NUMERIC(10,2) y el esquema
 * no admite una coma ni ceros de mas.
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

/** El precio como texto que se le puede mandar al esquema, o null si no. */
export function problemaDePrecio(texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === '') return null;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(limpio.replace(',', '.'))) {
    return 'El precio debe ser un numero con hasta 2 decimales.';
  }
  if (Number(limpio.replace(',', '.')) < 0) return 'El precio no puede ser negativo.';
  return null;
}

/** La fecha de hoy en el formato que espera el esquema (AAAA-MM-DD). */
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

  /** Busca productos por codigo o nombre, para el selector del editor. */
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
}

/**
 * Los query params de una vista, quitando lo que esa vista no acepta.
 *
 * Existe por el `cliente_id`. Los dos listados validan sus query params con
 * `strictObject` (`backend/src/modules/precios/esquemas.ts`): el de precios de
 * lista NO tiene `cliente_id` entre sus claves, asi que mandarselo no lo
 * ignora, lo rechaza con un 400 y deja la pantalla en blanco. Antes se armaba
 * un solo objeto de criterios con `cliente_id` puesto siempre que hubiera
 * filtro de cliente, y como ese filtro no se quitaba al cambiar de pestana,
 * filtrar por un cliente y pasar a "Precio de lista" rompia el listado.
 *
 * Aqui se decide por vista, que es donde se sabe que key manda cada una.
 *
 * El `offset` sale de la pagina y del limite, no se pasa: un numero de pagina
 * guardado seria un `offset` guardado, que envejece en cuanto cambia el filtro.
 */
export function criteriosDe(
  vista: 'publicos' | 'clientes',
  filtros: {
    productoId?: number;
    clienteId?: number;
    vigencia: Vigencia;
    limite: number;
    pagina: number;
  },
): Criterios {
  const criterios: Criterios = {
    vigencia: filtros.vigencia,
    limite: filtros.limite,
    offset: (filtros.pagina - 1) * filtros.limite,
  };
  if (filtros.productoId !== undefined) criterios.producto_id = filtros.productoId;
  if (vista === 'clientes' && filtros.clienteId !== undefined) {
    criterios.cliente_id = filtros.clienteId;
  }
  return criterios;
}

/** Los criterios que si van, y el vigencia siempre para que el backend decida. */
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
