import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * La API de clientes.
 *
 * Los tipos son un espejo de `backend/src/modules/clientes`. El RFC y la
 * razon social vienen de `datos_fiscales_cliente` (LEFT JOIN en el listado)
 * pero NO se pueden escribir por esta API: el esquema de alta/edicion no
 * los acepta, igual que el del backend. Por eso la forma del editor no los
 * lleva, y la fila si, para que se puedan ver.
 *
 * La lista responde con forma DISTINTA a la de productos: aqui es
 * `{ datos, paginacion: { limite, offset, total } }` (ver
 * `clientes/servicio.ts`), y productos manda el total suelto. Cada pantalla
 * define su propia envoltura.
 */

// --------------------------------------------------------------------- tipos

/** `clientes/modelo.ts` -> `Cliente`. */
export interface Cliente {
  id: number;
  codigo_cliente: string | null;
  nombre: string;
  establo: string | null;
  especie_id: number | null;
  especie: string | null;
  estatus: 'Activo' | 'Inactivo';
  telefono: string | null;
  direccion: string | null;
  rfc: string | null;
  razon_social: string | null;
  saldo_actual: number;
  creado_en: string;
  actualizado_en: string;
}

/** `catalogo/modelo.ts` -> `Especie`. Solo se usa el id y el nombre. */
export interface Especie {
  id: number;
  nombre: string;
}

/** La envoltura del listado de clientes (`clientes/servicio.ts`). */
export interface ListaClientes {
  datos: Cliente[];
  paginacion: { limite: number; offset: number; total: number };
}

/**
 * La forma del editor, tal como la arma la pantalla.
 *
 * Van como TEXTO los campos que el backend recibe opcionales o numericos:
 * el select de especie manda `''` cuando no se elige ninguna, y el cuerpo
 * la convierte en `null`. Asi el formulario no tiene que saber distinguir
 * "vacio" de "no existe", que es problema del borde.
 */
export interface FormaCliente {
  codigo_cliente: string;
  nombre: string;
  establo: string;
  especie_id: string;
  estatus: 'Activo' | 'Inactivo';
  telefono: string;
  direccion: string;
}

/** El cuerpo de `POST/PATCH /api/clientes`, tal como lo quiere el esquema. */
export interface CuerpoCliente {
  codigo_cliente: string;
  nombre: string;
  establo: string | null;
  especie_id: number | null;
  estatus: 'Activo' | 'Inactivo';
  telefono: string | null;
  direccion: string | null;
}

/**
 * La forma del editor convertida al cuerpo de la peticion.
 *
 * El codigo va en MAYUSCULAS y limpio de espacios: el esquema del backend
 * ya lo transforma asi, y hacerlo aqui evita que el listado refrescado
 * muestre el codigo con mayusculas distinto al que se tecleo.
 */
export function cuerpoDeCliente(forma: FormaCliente): CuerpoCliente {
  return {
    codigo_cliente: forma.codigo_cliente.trim().toUpperCase(),
    nombre: forma.nombre.trim(),
    establo: textoONull(forma.establo),
    especie_id: forma.especie_id === '' ? null : Number(forma.especie_id),
    estatus: forma.estatus,
    telefono: textoONull(forma.telefono),
    direccion: textoONull(forma.direccion),
  };
}

/** Un campo opcional que llego en blanco se manda como `null`, que es como
 * lo trata la base: sin dato, no con un string de espacios. */
function textoONull(valor: string): string | null {
  const limpio = valor.trim();
  return limpio === '' ? null : limpio;
}

// ----------------------------------------------------------------- el cuerpo

@Injectable({ providedIn: 'root' })
export class ClientesApi {
  private readonly http = inject(HttpClient);

  /**
   * Lista con filtros y paginacion.
   *
   * `buscar` busca en nombre, codigo Y rfc (el LEFT JOIN del listado); aqui
   * se envuelve solo en el minimo de dos caracteres, igual que el buscador
   * del POS: con uno el backend trae medio catalogo.
   */
  async listar(opciones: {
    buscar?: string;
    estatus?: 'Activo' | 'Inactivo';
    limite?: number;
    offset?: number;
  }): Promise<ListaClientes> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
    };
    if (opciones.buscar) params['buscar'] = opciones.buscar;
    if (opciones.estatus) params['estatus'] = opciones.estatus;
    return firstValueFrom(this.http.get<ListaClientes>(`${API}/clientes`, { params }));
  }

  /** Crea. 201 + el cliente con su id. */
  async crear(cuerpo: CuerpoCliente): Promise<Cliente> {
    return firstValueFrom(this.http.post<Cliente>(`${API}/clientes`, cuerpo));
  }

  /** Edita con PATCH parcial. */
  async actualizar(id: number, cuerpo: CuerpoCliente): Promise<Cliente> {
    return firstValueFrom(this.http.patch<Cliente>(`${API}/clientes/${id}`, cuerpo));
  }

  /** Borra. 204 si salio. */
  async eliminar(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`${API}/clientes/${id}`));
  }

  /** El catalogo de especies para el select del editor. */
  async especies(): Promise<Especie[]> {
    const respuesta = await firstValueFrom(this.http.get<{ datos: Especie[] }>(`${API}/especies`));
    return respuesta.datos;
  }
}
