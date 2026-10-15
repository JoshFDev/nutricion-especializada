import { HttpClient, type HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API, descargarExcel } from '../nucleo/api';

/**
 * El servicio del estado de cuenta por cliente.
 *
 * Son dos llamadas y las dos son de SOLO LECTURA: el listado de clientes con su
 * saldo y la hoja en Excel de uno. No hay nada que crear porque no hay nada
 * que guardar: la cuenta la calcula el sistema con las ventas y los abonos.
 *
 * Los tipos son un espejo de los de `estado-cuenta/modelo.ts`. No se comparten
 * con el sistema (son dos partes), y por eso cada uno lleva de qué archivo
 * salió.
 */

/** La envoltura de los listados. `modelo.ts` -> `Listado`. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** Una fila del listado: cuánto debe un cliente y cuándo se movió por última vez. */
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
 * Los parámetros del listado, como texto para la dirección.
 *
 * Es una función PURA y exportada para poder probarla sin levantar el
 * servicio. Las reglas de validación no admiten campos de más, así que un
 * parámetro extra da un 400 y lo que importa es QUÉ se manda y qué NO: la
 * bandera solo viaja encendida (el sistema la lee como 'true' o 'false', y no
 * mandarla es "sin filtro") y `buscar` solo desde dos caracteres, porque con
 * uno el sistema trae medio catálogo.
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

  /** El listado de clientes con su saldo y sus dos últimas fechas. */
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
   * NO se abre en una pestaña: un `.xlsx` no lo abre el navegador. Va como
   * archivo adjunto desde el sistema y aquí se baja como archivo con el `<a>`
   * temporal de `descargarExcel`, sin tocar la página.
   *
   * Devuelve cuántos movimientos se quedaron fuera de las 20 filas del papel:
   * el sistema lo manda en la cabecera `X-Renglones-Fuera`, que es lo único
   * que se puede leer de una respuesta que es un archivo y no datos. La
   * pantalla lo usa para avisar que la cuenta trae más de lo que cabe.
   */
  async abrirHoja(
    clienteId: number,
    rango: 'todo' | 'semana' | 'mes' | 'personalizado' = 'todo',
    opts?: { fecha_inicio?: string; fecha_fin?: string },
  ): Promise<number> {
    const params: any = { rango };
    if (rango === 'personalizado') {
      if (opts?.fecha_inicio) params.fecha_inicio = opts.fecha_inicio;
      if (opts?.fecha_fin) params.fecha_fin = opts.fecha_fin;
    }
    const respuesta: HttpResponse<Blob> = await firstValueFrom(
      this.http.get(`${API}/estado-cuenta/${clienteId}/hoja`, {
        params,
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
