import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * El catálogo de direcciones de entrega de la sucursal.
 *
 * Es un archivo aparte, y no tres funciones más de `notas-api.ts`, porque son
 * cosas distintas: la nota es un papel que se emite y ya no se toca; la
 * dirección es una lista de destinos que se agrega, se corrige y se borra, y
 * sus permisos (`direcciones.*`) y la forma de guardarla no tienen nada que
 * ver con los de `notas.*`. Mezclarlos dejaría un archivo donde la mitad del
 * código no aplica a la otra mitad.
 *
 * Como en el resto del sistema, los datos de aquí son los mismos que maneja el
 * servicio (`modules/direcciones/modelo.ts`).
 */
export interface DireccionEntrega {
  id: number;
  nombre: string;
  direccion: string;
}

/** Lo que se manda al crear o al corregir. En los dos casos es lo mismo. */
export interface CuerpoDireccion {
  nombre: string;
  direccion: string;
}

/** El molde con el que llega la lista, igual que en el resto del sistema. */
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
   * No se parten en páginas a propósito: son unas decenas de filas y la
   * pantalla las necesita TODAS para el desplegable de "a dónde va esta nota".
   * Partirlas sería meter un buscador dentro de otro buscador.
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
   * Se mandan siempre los dos campos (ver `modulos/direcciones/rutas.ts`),
   * así que corregir el nombre sin tocar la dirección conserva la dirección
   * que ya estaba.
   */
  async editar(id: number, cuerpo: CuerpoDireccion): Promise<DireccionEntrega> {
    return firstValueFrom(
      this.http.put<DireccionEntrega>(`${API}/direcciones-entrega/${id}`, cuerpo),
    );
  }

  /**
   * Borra la dirección del catálogo.
   *
   * No toca ninguna nota: la nota copió el texto y no depende de aquí (ver la
   * actualización del sistema 0011). Por eso el botón puede ofrecer el borrado
   * sin preguntar antes "¿está en uso?".
   */
  async borrar(id: number): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${API}/direcciones-entrega/${id}`));
  }
}
