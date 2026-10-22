import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * El servicio de reportes.
 *
 * Son tres cosas de SOLO LECTURA:
 *
 *   - Las EXISTENCIAS, que ya estan en la pantalla de inventario.
 *   - Las ALERTAS: la tabla `alertas` la llenan los triggers (hoy, el de
 *     stock negativo) y antes no la leia nadie. El estado ACTUAL del stock
 *     se ve en el inventario (el filtro de "vacios"); esto es el
 *     HISTORICO de cuando se quedo sin.
 *   - La CONCILIACION entre la cartera y la caja: un cobro se anota en dos
 *     tablas (lo que el cliente debe, y de donde salio el dinero) y el
 *     vinculo entre las dos permite cruzarlas.
 *
 * Las tres piden el permiso `reportes.ver`.
 */

/** Una fila de `alertas`: el aviso que dejo un trigger. */
export interface Alerta {
  id: number;
  tipo: string;
  descripcion: string;
  tabla_origen: string | null;
  registro_id: number | null;
  /** Si alguien ya la reviso. Hoy nadie la marca: se devuelven todas. */
  atendida: boolean;
  creado_en: string;
}

/** La envoltura del listado. */
export interface ListaAlertas {
  datos: Alerta[];
  total: number;
  limite: number;
  offset: number;
}

/** Un cobro de la cartera que no tiene su movimiento de caja. */
export interface CobroSinMovimiento {
  id: number;
  cliente: string | null;
  monto: number;
  fecha: string;
}

/** El resultado de cruzar la cartera con la caja. */
export interface Conciliacion {
  pagos_sin_movimiento: CobroSinMovimiento[];
  movimientos_con_otro_monto: {
    pago_id: number;
    movimiento_id: number;
    monto_pago: number;
    monto_movimiento: number;
  }[];
  pagos_con_dos_movimientos: { pago_id: number; movimientos: number }[];
}

@Injectable({ providedIn: 'root' })
export class ReportesApi {
  private readonly http = inject(HttpClient);

  /**
   * Las alertas, de la mas nueva a la mas vieja.
   *
   * `tipo` filtra por tipo de aviso (hoy, `stock_negativo`).
   */
  async alertas(opciones: { tipo?: string; limite?: number } = {}): Promise<ListaAlertas> {
    const params: Record<string, string> = {};
    if (opciones.tipo !== undefined) params['tipo'] = opciones.tipo;
    if (opciones.limite !== undefined) params['limite'] = String(opciones.limite);

    return firstValueFrom(this.http.get<ListaAlertas>(`${API}/reportes/alertas`, { params }));
  }

  /** La conciliacion entre la cartera y la caja. */
  async conciliacion(): Promise<Conciliacion> {
    return firstValueFrom(this.http.get<Conciliacion>(`${API}/reportes/conciliacion-caja`));
  }
}
