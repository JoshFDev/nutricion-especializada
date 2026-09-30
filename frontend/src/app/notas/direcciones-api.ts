import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * El catalogo de direcciones de entrega de la sucursal.
 *
 * Es UN archivo propio, y no tres metodos mas de `notas-api.ts`, por una
 * razon que se ve al escribirlo: son recursos distintos. La nota es un
 * documento que se emite y no se toca; la direccion es una lista de destinos
 * que se agrega, se corrige y se borra, y sus tipos, sus permisos
 * (`direcciones.*`) y su tabla no tienen nada que ver con los de
 * `notas.*`. Mezclarlos seria dejar un archivo donde la mitad de los metodos no
 * aplica a la otra mitad, que es el sintoma de un archivo que no sabe que es.
 *
 * Como en el resto de la app, los tipos son un espejo de los del backend
 * (`modules/direcciones/modelo.ts`) y no se comparten.
 */
export interface DireccionEntrega {
  id: number;
  nombre: string;
  direccion: string;
}

/** Que se manda al crear o al corregir. Los dos cuerpos son el mismo. */
export interface CuerpoDireccion {
  nombre: string;
  direccion: string;
}

/** La envoltura del listado, igual que en el resto de la API. */
interface ListadoDirecciones {
  datos: DireccionEntrega[];
  total: number;
}

@Injectable({ providedIn: 'root' })
export class DireccionesApi {
  private readonly http = inject(HttpClient);

  /**
   * Todas las direcciones, ordenadas por nombre.
   *
   * Sin paginacion a proposito: son unas decenas de filas y la pantalla las
   * necesita TODAS para el desplegable de "a donde va esta nota". Paginarlas
   * significaria un buscador dentro de un buscador.
   */
  async listar(): Promise<DireccionEntrega[]> {
    const respuesta = await firstValueFrom(
      this.http.get<ListadoDirecciones>(`${API}/direcciones-entrega`),
    );
    return respuesta.datos;
  }

  async crear(cuerpo: CuerpoDireccion): Promise<DireccionEntrega> {
    return firstValueFrom(this.http.post<DireccionEntrega>(`${API}/direcciones-entrega`, cuerpo));
  }

  /**
   * Corrige el nombre y/o el texto.
   *
   * `PUT` y no `PATCH`: el backend manda los dos campos siempre (ver
   * `modulos/direcciones/rutas.ts`), asi que corregir el nombre sin tocar la
   * direccion sigue mandando la direccion que ya estaba.
   */
  async editar(id: number, cuerpo: CuerpoDireccion): Promise<DireccionEntrega> {
    return firstValueFrom(
      this.http.put<DireccionEntrega>(`${API}/direcciones-entrega/${id}`, cuerpo),
    );
  }

  /**
   * Borra la direccion del catalogo.
   *
   * No toca ninguna nota: la nota copio el texto y no apunta aqui (ver la
   * migracion 0011). Por eso el boton puede ofrecer el borrado sin la
   * pregunta de "esta en uso" que hacen las especies.
   */
  async borrar(id: number): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${API}/direcciones-entrega/${id}`));
  }
}
