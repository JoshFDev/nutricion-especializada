import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * La API de especies, categorias y almacenes.
 *
 * El backend las ATIENDE como una sola cosa: `catalogo/rutas.ts` construye
 * las tres rutas con la misma fabrica, y aqui el cliente hace lo mismo. La
 * unica diferencia de verdad es el nombre en la URL (`categorias-producto`
 * vs `especies` vs `almacenes`), que se resuelve con `rutaDe`.
 *
 * La lista de estas tablas es CHICA (una docena de filas), por eso
 * `listar` no lleva filtros ni paginacion: el backend devuelve el catalogo
 * completo en `{ datos, total }`, a diferencia de clientes y productos
 * que si pagina.
 */

/** Especies, categorias y almacenes comparten forma: id + nombre. `catalogo/modelo.ts`. */
export interface FilaCatalogo {
  id: number;
  nombre: string;
  /**
   * Cuantas filas la apuntan (productos y clientes en las especies,
   * mercancia en los almacenes).
   *
   * Lo trae el listado (`FilaCatalogoConUsos` en el backend) y es lo que
   * permite el filtro "En uso / Sin uso". Sin el, el unico filtro posible
   * seria el nombre, y el nombre no dice si esa categoria la usan tres
   * productos o ninguno — que es justo lo que uno quiere saber antes de
   * intentar borrarla y comerse el 409 EN_USO.
   */
  usos: number;
}

/** Las tres tablas del catalogo. `ClaveRecurso` en `catalogo/repositorio.ts`. */
export type ClaveRecurso = 'categorias' | 'especies' | 'almacenes';

/**
 * La URL de cada una. Solo `categorias` se llama distinto en el backend;
 * las otras dos llevan el nombre del recurso.
 */
export function rutaDe(recurso: ClaveRecurso): string {
  return recurso === 'categorias' ? 'categorias-producto' : recurso;
}

/**
 * El permiso de una accion sobre un recurso.
 *
 * El backend los separa: `categorias.ver/crear/editar/eliminar`,
 * `especies.*` y `almacenes.*`. Leer va por permiso granular (los tres
 * roles lo tienen), escribir es del administrador (migraciones 0003 y
 * 0015), y la pantalla muestra los botones segun lo que la persona pueda
 * hacer de verdad.
 */
export function permisoDe(recurso: ClaveRecurso, accion: 'crear' | 'editar' | 'eliminar'): string {
  return `${recurso}.${accion}`;
}

/** El cuerpo de alta y renombrado: solo el nombre, limpio. */
export function cuerpoDeCatalogo(nombre: string): { nombre: string } {
  return { nombre: nombre.trim() };
}

@Injectable({ providedIn: 'root' })
export class CatalogoApi {
  private readonly http = inject(HttpClient);

  /** Todo el catalogo, en orden del espanol (`nombre COLLATE pos.es_es`). */
  async listar(recurso: ClaveRecurso): Promise<FilaCatalogo[]> {
    const respuesta = await firstValueFrom(
      this.http.get<{ datos: FilaCatalogo[] }>(`${API}/${rutaDe(recurso)}`),
    );
    return respuesta.datos;
  }

  /** Alta. 201 + la fila con el id nuevo. */
  async crear(recurso: ClaveRecurso, nombre: string): Promise<FilaCatalogo> {
    return firstValueFrom(
      this.http.post<FilaCatalogo>(`${API}/${rutaDe(recurso)}`, cuerpoDeCatalogo(nombre)),
    );
  }

  /**
   * Renombra.
   *
   * Es PUT y no PATCH: el esquema del backend solo acepta `nombre` y el id
   * nunca cambia, asi que no hay nada mas que mandar. Solo se renombra.
   */
  async renombrar(recurso: ClaveRecurso, id: number, nombre: string): Promise<FilaCatalogo> {
    return firstValueFrom(
      this.http.put<FilaCatalogo>(`${API}/${rutaDe(recurso)}/${id}`, cuerpoDeCatalogo(nombre)),
    );
  }

  /** Borra. 204, o 409 EN_USO si ya la usan productos o clientes. */
  async eliminar(recurso: ClaveRecurso, id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`${API}/${rutaDe(recurso)}/${id}`));
  }

  /** Exporta el catalogo a Excel. */
  async exportarExcel(recurso: ClaveRecurso): Promise<void> {
    const resp = await firstValueFrom(
      this.http.get(`${API}/${rutaDe(recurso)}/exportar`, {
        responseType: 'blob',
        observe: 'response',
      }),
    );
    const blob = resp.body!;
    const disposition = resp.headers.get('Content-Disposition');
    const match = disposition?.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `${recurso}.xlsx`;
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
  }
}
