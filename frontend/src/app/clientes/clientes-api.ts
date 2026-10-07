import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API, descargarExcel } from '../nucleo/api';
import { rfcNormalizado } from '../usuarios/usuarios-api';

/**
 * La API de clientes.
 *
 * Los tipos son un espejo de `backend/src/modules/clientes`. El RFC y la
 * razón social vienen de `datos_fiscales_cliente` (LEFT JOIN en el
 * listado). El RFC SÍ se escribe por esta API: vive en esa tabla y no en
 * `clientes`, así que el backend lo recibe junto con el resto y escribe en
 * los dos lados. La razón social no: no se captura, y el servidor la guarda
 * con el nombre del cliente. Por eso la forma del editor lleva rfc y no
 * razón social, y la fila sí enseña las dos.
 *
 * La lista responde con forma DISTINTA a la de productos: aquí es
 * `{ datos, paginación: { limite, offset, total } }` (ver
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

/** `catálogo/modelo.ts` -> `Especie`. Solo se usa el id y el nombre. */
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
 * la convierte en `null`. Así el formulario no tiene que saber distinguir
 * "vacío" de "no existe", que es problema del borde.
 */
export interface FormaCliente {
  codigo_cliente: string;
  nombre: string;
  establo: string;
  especie_id: string;
  estatus: 'Activo' | 'Inactivo';
  telefono: string;
  rfc: string;
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
  rfc: string | null;
  direccion: string | null;
}

/**
 * La forma del editor convertida al cuerpo de la peticion.
 *
 * El código va en MAYUSCULAS y limpio de espacios: el esquema del backend
 * ya lo transforma así, y hacerlo aquí evita que el listado refrescado
 * muestre el código con mayúsculas distinto al que se tecleó.
 *
 * El RFC pasa por lo mismo (`rfcNormalizado`): si no, un tecleo en
 * minusculas llegaria al servidor y volveria en mayusculas, con la tabla
 * mostrando algo distinto a lo que quedo en el campo. En blanco va
 * `null`, que es como el backend lo entiende como "sin RFC" y lo usa para
 * borrar el dato fiscal.
 */
export function cuerpoDeCliente(forma: FormaCliente): CuerpoCliente {
  return {
    codigo_cliente: forma.codigo_cliente.trim().toUpperCase(),
    nombre: forma.nombre.trim(),
    establo: textoONull(forma.establo),
    especie_id: forma.especie_id === '' ? null : Number(forma.especie_id),
    estatus: forma.estatus,
    telefono: textoONull(forma.telefono),
    rfc: textoONull(rfcNormalizado(forma.rfc)),
    direccion: textoONull(forma.direccion),
  };
}

/** Un campo opcional que llegó en blanco se manda como `null`, que es como
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
   * Lista con filtros y paginación.
   *
   * `buscar` busca en nombre, código Y rfc (el LEFT JOIN del listado); aquí
   * se envuelve solo en el mínimo de dos caracteres, igual que el buscador
   * del POS: con uno el backend trae medio catálogo.
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

  /** Borra. 204 si salió. */
  async eliminar(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`${API}/clientes/${id}`));
  }

  /** El catálogo de especies para el select del editor. */
  async especies(): Promise<Especie[]> {
    const respuesta = await firstValueFrom(this.http.get<{ datos: Especie[] }>(`${API}/especies`));
    return respuesta.datos;
  }

  /**
   * Exporta a Excel lo que hay FILTRADO, no la página que se ve.
   *
   * Los filtros se mandan tal cuál y sin `limite`/`offset`: el backend tiene
   * su propia ruta sin paginación para esto, así que el archivo sale entero
   * aunque en la pantalla se este viendo la segunda de tres páginas. Por eso
   * esta fuera de `listar()` y no es un `listar` con otros parametros.
   */
  async exportarExcel(filtro: { buscar?: string; estatus?: 'Activo' | 'Inactivo' }): Promise<void> {
    const params: Record<string, string> = {};
    if (filtro.buscar) params['buscar'] = filtro.buscar;
    if (filtro.estatus) params['estatus'] = filtro.estatus;

    const respuesta = await firstValueFrom(
      this.http.get(`${API}/clientes/exportar`, {
        params,
        responseType: 'blob',
        observe: 'response',
      }),
    );
    descargarExcel(respuesta, 'clientes.xlsx');
  }
}
