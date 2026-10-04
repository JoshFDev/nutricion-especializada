import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * La API de productos.
 *
 * Tipos espejo de `backend/src/modules/productos`. La envoltura de la lista
 * es DISTINTA a la de clientes: aqui es `{ datos, total, limite, offset }`
 * (ver `productos/servicio.ts`), y clientes manda el total anidado.
 *
 * El `tipo` alta/edicion no tiene `activo` a proposito: el esquema de
 * CREAR no lo acepta (`crearProductoEsquema`, ver `productos/esquemas.ts`)
 * y el de editar si, asi que la edicion lo manda aparte en
 * `actualizarActivo` y el alta no lo menciona.
 */

// --------------------------------------------------------------------- tipos

/** `productos/modelo.ts` -> `Producto`. */
export interface Producto {
  id: number;
  codigo: string;
  nombre: string;
  presentacion_kg: number;
  categoria_id: number | null;
  especie_id: number | null;
  categoria: string | null;
  especie: string | null;
  activo: boolean;
  creado_en: string;
  actualizado_en: string;
}

/**
 * `catalogo/modelo.ts` -> `Especie` y `CategoriaProducto`, misma forma.
 *
 * `usos` lo trae solo el listado del catalogo (`FilaCatalogoConUsos`): son
 * las filas que lo apuntan. Aqui no se usa —el desplegable del editor solo
 * necesita el nombre— pero viene en la misma respuesta y asi el tipo de las
 * dos pantallas no se contradice.
 */
export interface Catalogo {
  id: number;
  nombre: string;
  usos?: number;
}

/** La envoltura del listado de productos (`productos/servicio.ts`). */
export interface ListaProductos {
  datos: Producto[];
  total: number;
  limite: number;
  offset: number;
}

/**
 * La forma del editor.
 *
 * `presentacion_kg` va como TEXTO a proposito: el esquema del backend lo
 * acepta numero o string y lo normaliza a string antes de validar (ver
 * `presentacionKg` en `productos/esquemas.ts`), y mandar el texto evita
 * que el double de JavaScript se cuele en la validacion decimal.
 */
export interface FormaProducto {
  codigo: string;
  nombre: string;
  presentacion_kg: string;
  categoria_id: string;
  especie_id: string;
}

/** El cuerpo de `POST /api/productos`. El `activo` lo pone la base. */
export interface CuerpoProducto {
  codigo: string;
  nombre: string;
  presentacion_kg: string;
  categoria_id: number | null;
  especie_id: number | null;
}

/** La forma del editor convertida al cuerpo de la peticion. */
export function cuerpoDeProducto(forma: FormaProducto): CuerpoProducto {
  return {
    codigo: forma.codigo.trim(),
    nombre: forma.nombre.trim(),
    presentacion_kg: forma.presentacion_kg.trim(),
    categoria_id: forma.categoria_id === '' ? null : Number(forma.categoria_id),
    especie_id: forma.especie_id === '' ? null : Number(forma.especie_id),
  };
}

// ----------------------------------------------------------------- el cuerpo

@Injectable({ providedIn: 'root' })
export class ProductosApi {
  private readonly http = inject(HttpClient);

  /**
   * Lista con filtros y paginacion.
   *
   * `activo` trae tres estados y no un booleano porque el backend distingue
   * "solo activos", "solo inactivos" y "todos" (ver `listarProductosEsquema`),
   * y por omision salen solo los activos.
   */
  async listar(opciones: {
    buscar?: string;
    activo?: 'todos' | 'activos' | 'inactivos';
    categoria_id?: number;
    especie_id?: number;
    limite?: number;
    offset?: number;
  }): Promise<ListaProductos> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
      activo: opciones.activo ?? 'activos',
    };
    if (opciones.buscar) params['buscar'] = opciones.buscar;
    if (opciones.categoria_id !== undefined) params['categoria_id'] = opciones.categoria_id;
    if (opciones.especie_id !== undefined) params['especie_id'] = opciones.especie_id;
    return firstValueFrom(this.http.get<ListaProductos>(`${API}/productos`, { params }));
  }

  /** Crea. 201 + el producto con sus joins resueltos. */
  async crear(cuerpo: CuerpoProducto): Promise<Producto> {
    return firstValueFrom(this.http.post<Producto>(`${API}/productos`, cuerpo));
  }

  /**
   * Edita.
   *
   * El esquema es `strict`: `activo` va aparte del resto porque en el alta
   * NO existe, y mezclarlo haria que el alta envia un campo que el esquema
   * de crear no conoce. Por eso `actualizar` recibe todo el cuerpo y el
   * estado por separado.
   */
  async actualizar(id: number, cuerpo: CuerpoProducto, activo: boolean): Promise<Producto> {
    return firstValueFrom(
      this.http.patch<Producto>(`${API}/productos/${id}`, { ...cuerpo, activo }),
    );
  }

  /** Borra (solo productos sin historial). 204 si salio. */
  async eliminar(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`${API}/productos/${id}`));
  }

  /** Categorias para el select del editor. */
  async categorias(): Promise<Catalogo[]> {
    const respuesta = await firstValueFrom(
      this.http.get<{ datos: Catalogo[] }>(`${API}/categorias-producto`),
    );
    return respuesta.datos;
  }

  /** Especies para el select del editor. */
  async especies(): Promise<Catalogo[]> {
    const respuesta = await firstValueFrom(this.http.get<{ datos: Catalogo[] }>(`${API}/especies`));
    return respuesta.datos;
  }

  /** Exporta la lista de productos a Excel. */
  async exportarExcel(filtro: {
    buscar?: string;
    activo?: 'todos' | 'activos' | 'inactivos';
    categoria_id?: number;
    especie_id?: number;
  }): Promise<void> {
    const params: Record<string, string | number> = {
      activo: filtro.activo ?? 'activos',
    };
    if (filtro.buscar) params['buscar'] = filtro.buscar;
    if (filtro.categoria_id !== undefined) params['categoria_id'] = filtro.categoria_id;
    if (filtro.especie_id !== undefined) params['especie_id'] = filtro.especie_id;

    const respuesta = await firstValueFrom(
      this.http.get(`${API}/productos/exportar/excel`, {
        params,
        responseType: 'blob',
        observe: 'response',
      }),
    );

    const url = URL.createObjectURL(respuesta.body as Blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    const contentDisposition = respuesta.headers.get('content-disposition');
    const nombre = /filename="([^"]+)"/.exec(contentDisposition ?? '')?.[1] ?? 'productos.xlsx';
    enlace.download = nombre;
    enlace.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
