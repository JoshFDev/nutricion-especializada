import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { redondearMonto } from '../nucleo/cifras';

/**
 * La API de facturacion.
 *
 * Tipos espejo de `backend/src/modules/facturacion`. Una factura agrupa las
 * notas de remision que se le facturan juntas a un cliente, y hay tres cosas
 * de ese contrato que la pantalla tiene que respetar:
 *
 *   1. **`monto_total` NO se manda.** El esquema es `strict` y el servicio lo
 *      calcula sumando el subtotal de las notas que cubre. Es lo que el SAT
 *      ve, asi que no puede ser un numero tecleado: la pantalla lo muestra
 *      como preview y lo borra antes de enviar.
 *   2. **El estatus solo avanza.** `solicitada` -> `emitida` -> `cancelada`, y
 *      de ahi no sale. El unico "cambio" es un `PATCH /:id/estatus`, asi que
 *      no hay edicion: una factura se cancela y se pide otra.
 *   3. **Emitir y cancelar piden `facturas.emitir`.** La ruta pide
 *      `facturas.solicitar` y el servicio pide ese permiso aparte. Quien solo
 *      puede solicitar ve el boton de cancelar, lo aprieta y le dice que no:
 *      por eso el permiso se consulta aqui y el boton ni se muestra.
 */

export const ESTATUS_FACTURA = ['solicitada', 'emitida', 'cancelada'] as const;
export type EstatusFactura = (typeof ESTATUS_FACTURA)[number];

/** Los estatus de una nota, que es un CHECK en la base. */
export type EstatusNota = 'pendiente' | 'parcial' | 'pagada' | 'cancelada';

/** `facturacion/modelo.ts` -> `FacturaListada`, lo que muestra la tabla. */
export interface FacturaListada {
  id: number;
  cliente_id: number;
  cliente: string;
  fecha: string;
  metodo_pago: string | null;
  monto_total: number;
  estatus: EstatusFactura;
  /** Cuantas notas cubre. */
  notas: number;
  /** Derivado del estatus, para pintar de rojo sin comparar strings. */
  cancelada: boolean;
}

/** `facturacion/modelo.ts` -> `NotaFacturada`. */
export interface NotaFacturada {
  nota_id: number;
  /** El folio, no el id: es lo que se lee en el papel. */
  nota: string;
  fecha: string;
  subtotal: number;
  estatus: EstatusNota;
}

/** `facturacion/modelo.ts` -> `Factura`, el detalle. */
export interface Factura {
  id: number;
  cliente_id: number;
  cliente: string;
  fecha: string;
  metodo_pago: string | null;
  monto_total: number;
  estatus: EstatusFactura;
  motivo_cancelacion: string | null;
  creado_en: string;
  notas: NotaFacturada[];
}

/** La envoltura de los listados (`facturacion/modelo.ts` -> `Listado`). */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/**
 * Una nota del cliente, con su casilla de "va en esta factura".
 *
 * `elegida` vive en la pantalla y no se manda: el cuerpo solo lleva los
 * `nota_id` de las marcadas.
 */
export interface NotaPorFacturar {
  nota_id: number;
  folio: string;
  fecha: string;
  subtotal: number;
  estatus: EstatusNota;
  elegida: boolean;
}

/** El cuerpo de `POST /api/facturacion`. Sin `monto_total`, a proposito. */
export interface CuerpoFactura {
  cliente_id: number;
  /** `undefined` se omite al serializar: el esquema la toma opcional. */
  fecha?: string;
  metodo_pago: string | null;
  notas: number[];
}

/** El cuerpo de `PATCH /api/facturacion/:id/estatus`. */
export interface CuerpoEstatus {
  estatus: EstatusFactura;
  motivo: string | null;
}

// ------------------------------------------------------------------ el cuerpo

/**
 * Arma el cuerpo de la factura.
 *
 * Lo que se decide aqui:
 *
 *   - `notas` son SOLO los ids marcados, en el orden en que se ven. El
 *     servicio deduplica y ordena antes de sumar, asi que aqui no hace falta
 *     y un ids repetido no llega a contar dos veces.
 *   - `monto_total` no aparece: el esquema es `strict` y mandarlo seria un
 *     400. El total que se ve en pantalla es un preview (`montoDeNotas`) y el
 *     que vale es el que devuelve el servidor.
 *   - `metodo_pago` en blanco va como `null`. Es texto libre y NO es el enum
 *     de `pagos.metodo`: el metodo de un pago es como se recibio el dinero
 *     y el de una factura es la forma de pago del CFDI, que tiene sus
 *     codigos. Ver la nota de `facturacion/esquemas.ts`.
 *   - Una factura sin notas no se manda: el esquema pide al menos una, y una
 *     factura de cero pesos no es un documento.
 */
export function cuerpoDeFactura(
  clienteId: number,
  fecha: string,
  metodoPago: string,
  notas: NotaPorFacturar[],
): CuerpoFactura {
  const elegidas = notas.filter((n) => n.elegida);
  if (elegidas.length === 0) {
    throw new Error('una factura tiene que cubrir al menos una nota');
  }
  const metodo = metodoPago.trim();
  return {
    cliente_id: clienteId,
    fecha: fecha === '' ? undefined : fecha,
    metodo_pago: metodo === '' ? null : metodo,
    notas: elegidas.map((n) => n.nota_id),
  };
}

/** El cuerpo del cambio de estatus. El motivo solo lo usa `cancelada`. */
export function cuerpoDeEstatus(estatus: EstatusFactura, motivo: string): CuerpoEstatus {
  const limpio = motivo.trim();
  return { estatus, motivo: limpio === '' ? null : limpio };
}

/**
 * Lo que sumarian las notas marcadas.
 *
 * Es un PREVIEW para el operador, no el monto del documento: el que vale es
 * el `monto_total` que devuelve el servidor sumando los subtotales de la
 * base. Se redondea a dos decimales porque es la precision del
 * `NUMERIC(12,2)`, igual que en la suma del POS.
 */
export function montoDeNotas(notas: NotaPorFacturar[]): number {
  return redondearMonto(notas.filter((n) => n.elegida).reduce((suma, n) => suma + n.subtotal, 0));
}

/** Cuantas notas van marcadas. */
export function cuantasElegidas(notas: NotaPorFacturar[]): number {
  return notas.filter((n) => n.elegida).length;
}

/**
 * El unico camino de estatus, copiado de `facturacion/servicio.ts`.
 *
 * No es la autoridad —el servicio devuelve 409 `TRANSICION_NO_PERMITIDA` si
 * se le pide algo raro— pero decide que botones se ven, y ver "Emitir" en una
 * factura cancelada es ofrecer algo que va a fallar.
 */
const TRANSICIONES: Record<EstatusFactura, EstatusFactura[]> = {
  solicitada: ['emitida', 'cancelada'],
  emitida: ['cancelada'],
  cancelada: [],
};

export function puedePasarA(actual: EstatusFactura, destino: EstatusFactura): boolean {
  return TRANSICIONES[actual].includes(destino);
}

/** El estatus como se lee en la tabla. */
export function estatusComoTexto(estatus: EstatusFactura): string {
  return { solicitada: 'Solicitada', emitida: 'Emitida', cancelada: 'Cancelada' }[estatus];
}

/**
 * El estatus de una NOTA, que es el del POS y no el de la factura.
 *
 * Vive aqui y no en `pagos` porque las dos pantallas de facturacion lo
 * necesitan y duplicar el mapa dos veces es como se desincroniza uno de los
 * dos. `parcial` es el unico que necesita otra palabra: "Parcial" a secas no
 * dice si el cliente pagó la mitad o la nota esta a medias.
 */
export function estatusNotaComoTexto(estatus: EstatusNota): string {
  return {
    pendiente: 'Por pagar',
    parcial: 'Pago parcial',
    pagada: 'Pagada',
    cancelada: 'Cancelada',
  }[estatus];
}

/**
 * Por que no se puede cancelar todavia, o `null` si ya se puede.
 *
 * El backend pide un motivo no vacio y el CHECK de 0010 tambien, asi que el
 * control es el mismo de lado y lado. No se pide minimo de tres como en
 * compras: alli el esquema lo exige (`texto(..., 500, 3)`) y aqui no.
 */
export function problemaDeMotivo(motivo: string): string | null {
  return motivo.trim() === '' ? 'Escribe por qué se cancela la factura.' : null;
}

// ---------------------------------------------------------------- las llamadas

@Injectable({ providedIn: 'root' })
export class FacturacionApi {
  private readonly http = inject(HttpClient);

  /** Busca clientes para el selector, con el mismo minimo de dos del POS. */
  async clientes(buscar: string): Promise<{ id: number; nombre: string }[]> {
    if (buscar.trim().length < 2) return [];
    const respuesta = await firstValueFrom(
      this.http.get<Listado<{ id: number; nombre: string }>>(`${API}/clientes`, {
        params: { buscar: buscar.trim(), limite: 20 },
      }),
    );
    return respuesta.datos;
  }

  /**
   * Las notas del cliente que se PUEDEN facturar.
   *
   * Se piden los tres estatus vivos (pendiente, parcial y pagada) porque el
   * listado filtra por uno solo, y se juntan. Una nota pagada tambien se
   * factura: que la venta este cobrada no dice nada del CFDI, y las cajas que
   * cobran antes de facturar son lo normal.
   *
   * La CANCELADA no se ofrece, porque el servicio la rechaza con un 409 y es
   * mercancia que no salio.
   *
   * Lo que NO se puede filtrar aqui es una nota que ya esta en otra factura
   * activa: el listado de notas no lo dice, y no hay endpoint que lo diga
   * (`factura_nota` es del lado del servidor). Por eso la pantalla explica el
   * 409 `NOTA_YA_FACTURADA` con el numero de factura en vez de fingir que no
   * puede pasar. El rango es acotado: 200 notas es el maximo que acepta una
   * factura, asi que es tambien el tope de lo que se ofrece.
   *
   * Ojo con el permiso: este listado es el de notas (`notas.ver`), no uno de
   * facturacion. Quien tenga `facturas.solicitar` sin `notas.ver` no podra
   * armar la factura; es un permiso de mas que hace falta para facturar.
   */
  async notasFacturables(clienteId: number): Promise<NotaPorFacturar[]> {
    const pedidos = (['pendiente', 'parcial', 'pagada'] as const).map((estatus) =>
      firstValueFrom(
        this.http.get<Listado<NotaListada>>(`${API}/notas-remision`, {
          params: { cliente_id: clienteId, estatus, limite: 200 },
        }),
      ),
    );
    const [pendientes, parciales, pagadas] = await Promise.all(pedidos);
    return [...pendientes.datos, ...parciales.datos, ...pagadas.datos]
      .sort((a, b) => a.folio.localeCompare(b.folio))
      .map((n) => ({
        nota_id: n.id,
        folio: n.folio,
        fecha: n.fecha,
        subtotal: n.subtotal,
        estatus: n.estatus,
        elegida: false,
      }));
  }

  /** El listado de la tabla, con los filtros de la pantalla. */
  async listar(opciones: {
    buscar?: string;
    estatus?: EstatusFactura;
    desde?: string;
    hasta?: string;
    limite?: number;
    offset?: number;
  }): Promise<Listado<FacturaListada>> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
    };
    if (opciones.buscar) params['buscar'] = opciones.buscar;
    if (opciones.estatus) params['estatus'] = opciones.estatus;
    if (opciones.desde) params['desde'] = opciones.desde;
    if (opciones.hasta) params['hasta'] = opciones.hasta;
    return firstValueFrom(this.http.get<Listado<FacturaListada>>(`${API}/facturacion`, { params }));
  }

  /** El detalle con las notas que cubre. La usa "Ver" en la tabla. */
  async obtener(id: number): Promise<Factura> {
    return firstValueFrom(this.http.get<Factura>(`${API}/facturacion/${id}`));
  }

  /** Crea la factura y devuelve el detalle como lo armo el servidor. */
  async crear(cuerpo: CuerpoFactura): Promise<Factura> {
    return firstValueFrom(this.http.post<Factura>(`${API}/facturacion`, cuerpo));
  }

  /** El unico cambio que existe: mover el estatus. */
  async cambiarEstatus(id: number, cuerpo: CuerpoEstatus): Promise<Factura> {
    return firstValueFrom(this.http.patch<Factura>(`${API}/facturacion/${id}/estatus`, cuerpo));
  }
}

/** `notas-remision/modelo.ts` -> `NotaListada`, lo que devuelve el listado. */
interface NotaListada {
  id: number;
  folio: string;
  cliente_id: number;
  cliente: string;
  vendedor: string | null;
  fecha: string;
  subtotal: number;
  estatus: EstatusNota;
  renglones: number;
}
