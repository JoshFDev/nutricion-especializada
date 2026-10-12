import { HttpClient, type HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API, descargarExcel } from '../nucleo/api';

/**
 * La API del estado de cuenta por cliente.
 *
 * Son dos llamadas y las dos son de SOLO LECTURA: el listado de clientes con
 * su saldo (`GET /estado-cuenta`) y la hoja en Excel de uno
 * (`GET /estado-cuenta/:id/hoja`). No hay `POST` porque no hay nada que
 * guardar: la cuenta la calcula la base con las ventas y los abonos.
 *
 * Los tipos son un espejo de los del backend (`estado-cuenta/modelo.ts`). No
 * se comparten porque el front y el back son dos paquetes aparte, y por eso
 * cada uno lleva de que archivo salio.
 */

/** La envoltura de los listados. `modelo.ts` -> `Listado`. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** Una fila del listado: cuanto debe un cliente y cuando se movio por ultima vez. */
export interface RenglonEstadoCuenta {
  cliente_id: number;
  cliente: string;
  saldo_actual: number;
  ultima_venta: string | null;
  ultimo_pago: string | null;
}

/** Los filtros del listado. `esquemas.ts` -> `ListarEstadoCuenta`. */
export interface FiltrosEstadoCuenta {
  buscar?: string;
  /** Solo los clientes con saldo distinto de cero. */
  solo_con_saldo?: boolean;
  limite?: number;
  offset?: number;
}

/**
 * Los parametros del listado, como texto para la URL.
 *
 * Es una funcion PURA y exportada para poder probarla sin levantar HTTP. El
 * esquema del backend es `strict`, asi que un parametro de mas da un 400 y lo
 * que importa es QUE se manda y que NO: la bandera solo viaja encendida (el
 * backend la lee con un `enum('true','false')`, y no mandarla es "sin filtro")
 * y `buscar` solo desde dos caracteres, porque con uno el `ILIKE` trae medio
 * catalogo.
 */
export function parametrosEstadoCuenta(
  filtros: FiltrosEstadoCuenta,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    limite: filtros.limite ?? 25,
    offset: filtros.offset ?? 0,
  };
  const buscar = filtros.buscar?.trim();
  if (buscar && buscar.length >= 2) params['buscar'] = buscar;
  if (filtros.solo_con_saldo) params['solo_con_saldo'] = 'true';
  return params;
}

@Injectable({ providedIn: 'root' })
export class EstadoCuentaApi {
  private readonly http = inject(HttpClient);

  /** El listado de clientes con su saldo y sus dos ultimas fechas. */
  async listar(filtros: FiltrosEstadoCuenta): Promise<Listado<RenglonEstadoCuenta>> {
    return firstValueFrom(
      this.http.get<Listado<RenglonEstadoCuenta>>(`${API}/estado-cuenta`, {
        params: parametrosEstadoCuenta(filtros),
      }),
    );
  }

  /**
   * Baja la hoja de estado de cuenta del cliente como Excel.
   *
   * NO se abre en una pestana: un `.xlsx` no lo abre el navegador. Va como
   * `attachment` desde el backend y aqui se baja como archivo con el `<a>`
   * temporal de `descargarExcel`, sin tocar la pagina.
   *
   * Devuelve cuantos movimientos se quedaron fuera de las 20 filas del papel:
   * el backend lo manda en la cabecera `X-Renglones-Fuera`, que es lo unico
   * que se puede leer de una respuesta que es un archivo y no JSON. La
   * pantalla lo usa para avisar que la cuenta trae mas de lo que cabe.
   */
  async abrirHoja(clienteId: number): Promise<number> {
    const respuesta: HttpResponse<Blob> = await firstValueFrom(
      this.http.get(`${API}/estado-cuenta/${clienteId}/hoja`, {
        responseType: 'blob',
        observe: 'response',
      }),
    );

    descargarExcel(respuesta, `estado-cuenta-cliente-${clienteId}.xlsx`);
    return Number(respuesta.headers.get('x-renglones-fuera') ?? 0);
  }

  async generarGeneral(clienteIds: number[]): Promise<{ fuera: number; escritos: number }> {
    const respuesta: HttpResponse<Blob> = await firstValueFrom(
      this.http.post(
        `${API}/estado-cuenta/general`,
        { cliente_ids: clienteIds },
        {
          responseType: 'blob',
          observe: 'response',
        },
      ),
    );
    descargarExcel(respuesta, 'estado-cuenta-general.xlsx');
    return {
      fuera: Number(respuesta.headers.get('x-renglones-fuera') ?? 0),
      escritos: Number(respuesta.headers.get('x-renglones-escritos') ?? 0),
    };
  }
}
