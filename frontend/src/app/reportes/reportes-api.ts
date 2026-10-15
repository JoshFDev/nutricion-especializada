import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * Los tres reportes, en solo lectura.
 *
 * Son las vistas que dejó calculando la primera entrega y a las que nunca se
 * les dio pantalla: `vw_existencia_actual`, `vw_consumo_semanal_promedio` y
 * `vw_estado_cuenta_cliente`. Este módulo no permite escribir nada: no hay
 * tabla debajo que guardar, son consultas.
 *
 * Los nombres de las tres clases y los tres tipos llevan el dominio (reportes)
 * y no un número, igual que el resto de la aplicación. El `Listado` es la misma
 * forma que devuelve todo el servicio: `datos`, `total`, `limite` y `offset`.
 */

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** Una fila de la existencia: lo que hay de un producto en una bodega. */
export interface Existencia {
  producto_id: number;
  codigo: string;
  producto: string;
  almacen_id: number;
  almacen: string;
  existencia_bultos: number;
}

/** Los kilos que un cliente consume de un producto por semana, en promedio. */
export interface Consumo {
  cliente_id: number;
  cliente: string;
  producto_id: number;
  producto: string;
  kg_promedio_semanal: number;
}

/** Cuánto debe un cliente, y cuándo fue su última venta y su último pago. */
export interface EstadoCuenta {
  cliente_id: number;
  cliente: string;
  saldo_actual: number;
  ultima_venta: string | null;
  ultimo_pago: string | null;
}

/** Los filtros que las tres comparten. */
export interface Filtros {
  buscar?: string;
  /** Solo los renglones con existencia distinta de cero. */
  solo_con_existencia?: boolean;
  /** Solo los clientes con saldo distinto de cero. */
  solo_con_saldo?: boolean;
  limite?: number;
  offset?: number;
}

/**
 * Los parámetros de cualquiera de los tres reportes.
 *
 * Es una función PURA y exportada para poder probarla sin levantar el
 * servicio, que es como se prueban las demás pantallas: las reglas de
 * validación no admiten campos de más, así que un parámetro extra da un 400 y
 * lo que importa es QUÉ se manda y qué NO.
 *
 * `buscar` solo viaja desde dos caracteres: con uno solo el sistema trae medio
 * catálogo y la tabla deja de informar. La bandera se manda como texto `'true'`
 * y SOLO cuando va encendida: el sistema la valida como 'true' o 'false', así
 * que no mandarla es la forma de decir "sin filtro".
 */
export function parametrosDe(
  filtros: Filtros,
  bandera?: { nombre: string; valor: boolean },
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    limite: filtros.limite ?? 25,
    offset: filtros.offset ?? 0,
  };
  const buscar = filtros.buscar?.trim();
  if (buscar && buscar.length >= 2) params['buscar'] = buscar;
  if (bandera?.valor) params[bandera.nombre] = 'true';
  return params;
}

@Injectable({ providedIn: 'root' })
export class ReportesApi {
  private readonly http = inject(HttpClient);

  /**
   * Las tres llamadas son consultas con filtros y paginación, y solo cambian la
   * ruta y el filtro propio de cada una.
   */
  private async listar<T>(
    ruta: string,
    filtros: Filtros,
    bandera?: { nombre: string; valor: boolean },
  ): Promise<Listado<T>> {
    const params = parametrosDe(filtros, bandera);
    return firstValueFrom(this.http.get<Listado<T>>(`${API}/reportes/${ruta}`, { params }));
  }

  /** Existencia por producto y bodega. */
  existencia(filtros: Filtros): Promise<Listado<Existencia>> {
    return this.listar<Existencia>('existencia', filtros, {
      nombre: 'solo_con_existencia',
      valor: filtros.solo_con_existencia ?? false,
    });
  }

  /** Consumo semanal promedio por cliente y producto (últimas 8 semanas). */
  consumo(filtros: Filtros): Promise<Listado<Consumo>> {
    return this.listar<Consumo>('consumo-semanal', filtros);
  }

  /** Estado de cuenta por cliente. */
  estadoCuenta(filtros: Filtros): Promise<Listado<EstadoCuenta>> {
    return this.listar<EstadoCuenta>('estado-cuenta', filtros, {
      nombre: 'solo_con_saldo',
      valor: filtros.solo_con_saldo ?? false,
    });
  }
}
