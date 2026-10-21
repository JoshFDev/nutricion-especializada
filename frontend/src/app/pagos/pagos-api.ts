import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { decimalComoTexto, redondearMonto } from '../nucleo/cifras';

/**
 * El servicio de cobranza.
 *
 * Los tipos son un espejo de `pagos/modelo.ts`. El pago es un documento que NO
 * se borra ni se edita: se crea con su alta, se le ve el detalle, y si algo
 * salió mal se cancela la nota que cobraba, no el pago. La pantalla refleja
 * eso: no hay botones de editar ni borrar.
 *
 * El `metodo` es `null` a propósito (las reglas de validación lo reciben
 * nullish): un pago de mostrador en efectivo casi siempre llega sin método, y
 * el sistema lo acepta.
 */

// --------------------------------------------------------------------- tipos

export const METODOS_PAGO = ['Efectivo', 'Transferencia', 'Depósito'] as const;
export type MetodoPago = (typeof METODOS_PAGO)[number];

/** `pagos/modelo.ts` -> `PagoListado` (lo que muestra la tabla). */
export interface PagoListado {
  id: number;
  cliente_id: number;
  cliente: string;
  fecha: string;
  metodo: MetodoPago | null;
  monto: number;
  monto_aplicado: number;
  saldo: number;
  requiere_factura: boolean;
  referencia: string | null;
  notas: number;
}

/** `pagos/modelo.ts` -> `Pago` (el detalle con las aplicaciones). */
export interface Pago {
  id: number;
  cliente_id: number;
  cliente: string;
  fecha: string;
  metodo: MetodoPago | null;
  monto: number;
  monto_aplicado: number;
  saldo: number;
  requiere_factura: boolean;
  referencia: string | null;
  creado_en: string;
  aplicaciones: AplicacionPago[];
}

/** `pagos/modelo.ts` -> `AplicacionPago`. */
export interface AplicacionPago {
  id: number;
  nota_id: number;
  nota: string;
  monto: number;
  nota_estatus: 'pendiente' | 'parcial' | 'pagada' | 'cancelada';
}

/** `notas-remision/modelo.ts` -> `NotaListada`, lo que ofrece el listado. */
export interface NotaListada {
  id: number;
  folio: string;
  cliente_id: number;
  cliente: string;
  vendedor: string | null;
  fecha: string;
  subtotal: number;
  estatus: 'pendiente' | 'parcial' | 'pagada' | 'cancelada';
  renglones: number;
}

/** La envoltura de los listados. `pagos/modelo.ts` -> `Listado`. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/**
 * Una nota abierta con lo que se le va a aplicar, dentro del editor.
 *
 * `monto` va como TEXTO porque es lo que teclea la persona en un campo: recién
 * al guardar se convierte en el `monto` de la aplicación. Vacío, o en cero,
 * significa que esta nota NO entra en el pago: el sistema acepta un pago sin
 * aplicaciones (un abono a cuenta), y no mandar la nota es la única forma que
 * tiene la pantalla de "no la quiero cubrir".
 */
export interface AplicacionEditor {
  nota_id: number;
  folio: string;
  fecha: string;
  subtotal: number;
  estatus: 'pendiente' | 'parcial';
  monto: string;
}

// ------------------------------------------------------------------ el cuerpo

/** Los datos al registrar un pago, tal como los pide `crearPagoEsquema`. */
export interface CuerpoPago {
  cliente_id: number;
  fecha: string;
  metodo: MetodoPago | null;
  monto: string;
  requiere_factura: boolean;
  referencia: string | null;
  /**
   * La cuenta de caja (o de banco) que recibe el dinero.
   *
   * Opcional: si no viene, el sistema usa la primera del tipo que
   * corresponde al metodo. En cuanto hay mas de una, la pantalla la
   * manda, porque si no el corte de una caja sale mal sin que nadie se
   * entere de que hubo eleccion.
   */
  cuenta_id?: number;
  aplicaciones: { nota_id: number; monto: string }[];
}

/**
 * Arma los datos del pago.
 *
 * Lo que se decide aquí y no en la pantalla:
 *
 *   - `fecha` SIEMPRE se manda: las reglas de validación la aceptan opcional
 *     para no obligar al que llama, pero el editor tiene un campo de fecha con
 *     la de hoy ya puesta, y una fecha tecleada no debe caer en el huso del
 *     navegador. Mandarla explícita es lo honesto.
 *   - `metodo` en blanco va como `null`, no omitido: las reglas de validación
 *     no admiten campos de más, y las dos formas valen, pero `null` dice "no
 *     hay" igual que el sistema.
 *   - `aplicaciones` lleva SOLO las notas con monto. Una nota tocada en cero
 *     (o vacía) no se cubre, y por eso no aparece: el sistema valida
 *     `total <= monto` contra lo que se manda, y mandar ceros sería renglones
 *     que no aplican nada pero hacen sumar distinto.
 */
export function cuerpoDePago(
  clienteId: number,
  fecha: string,
  metodo: MetodoPago | null,
  monto: string,
  requiereFactura: boolean,
  referencia: string,
  aplicaciones: AplicacionEditor[],
  cuentaId?: number,
): CuerpoPago {
  const conMonto = aplicaciones.filter((a) => montoNumerico(a.monto) > 0);
  const referenciaLimpia = referencia.trim();

  const cuerpo: CuerpoPago = {
    cliente_id: clienteId,
    fecha,
    metodo,
    monto: decimalComoTexto(monto, 2),
    requiere_factura: requiereFactura,
    referencia: referenciaLimpia === '' ? null : referenciaLimpia,
    aplicaciones: conMonto.map((a) => ({
      nota_id: a.nota_id,
      monto: decimalComoTexto(a.monto, 2),
    })),
  };

  // La cuenta solo va si se eligio una. Mandarla en `undefined` seria
  // mandarla como ausente, que es lo mismo, pero asi queda claro que es
  // opcional de verdad.
  if (cuentaId !== undefined) {
    cuerpo.cuenta_id = cuentaId;
  }

  return cuerpo;
}

/**
 * Cuánto llevan aplicado las notas del editor.
 *
 * Es una vista previa para el saldo en pantalla ("ya llevas 500, el pago es de
 * 800"), no el monto del documento: el que vale es el que calcula el sistema
 * con `centavos()` (ver `pagos/servicio.ts`). Por eso se suma con decimales y
 * se redondea al final, igual que el `totalDeLineas` del punto de venta.
 */
export function montoDeAplicaciones(aplicaciones: AplicacionEditor[]): number {
  const total = aplicaciones.reduce((suma, a) => suma + montoNumerico(a.monto), 0);
  return redondearMonto(total);
}

/** El `monto` de una aplicación como número, o cero si no es un número usable. */
function montoNumerico(texto: string): number {
  const numero = Number(texto.trim().replace(',', '.'));
  return Number.isFinite(numero) ? numero : 0;
}

/**
 * Por qué una aplicación no se puede guardar, o null si está lista.
 *
 * Vacío quiere decir "esta nota no se cubre": la línea se queda en el editor
 * pero no entra a los datos que se mandan. Ya con texto, el monto tiene que
 * ser un número mayor que cero y no pasar del subtotal de la nota — el sistema
 * sigue comprobando contra el saldo real (una parcial ya tiene cobrado y aquí
 * no se sabe cuánto), y su `MONTO_MAYOR_A_NOTA` manda el `disponible`. Este
 * control es para que quien no se equivocó no se entere por el sistema.
 */
export function problemaDeAplicacion(a: AplicacionEditor): string | null {
  const limpio = a.monto.trim();
  if (limpio === '') return null;
  const numero = montoNumerico(limpio);
  if (numero <= 0) return 'El monto tiene que ser un número mayor que cero.';
  if (numero > a.subtotal) {
    return `No puede aplicar más de ${a.subtotal.toFixed(2)} a la nota ${a.folio}.`;
  }
  return null;
}

/** La fecha de hoy en el formato que esperan las reglas de validación (AAAA-MM-DD). */
export function hoyComoTexto(fecha = new Date()): string {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

// ------------------------------------------------------------------ las llamadas

@Injectable({ providedIn: 'root' })
export class PagosApi {
  private readonly http = inject(HttpClient);

  /** Busca clientes para el selector, igual que el punto de venta pero con su propio servicio. */
  async clientes(buscar: string): Promise<{ id: number; nombre: string; rfc: string | null }[]> {
    if (buscar.trim().length < 2) return [];
    const respuesta = await firstValueFrom(
      this.http.get<{ datos: { id: number; nombre: string; rfc: string | null }[] }>(
        `${API}/clientes`,
        { params: { buscar: buscar.trim(), limite: 20 } },
      ),
    );
    return respuesta.datos;
  }

  /**
   * Las notas ABIERTAS del cliente: cobrables de verdad.
   *
   * El sistema filtra por UN estatus a la vez (`listarNotasEsquema`), así que
   * aquí se piden las dos cosas que interesan a una caja (pendiente y parcial)
   * y se juntan. Una nota cancelada o pagada no aparece, y eso es lo correcto:
   * a la cancelada no se le puede aplicar (lo valida el sistema) y a la pagada
   * no le falta nada.
   *
   * No se pagina porque el rango es acotado: un cliente con más de 200 notas
   * abiertas sería un problema de cobranza que este filtro no va a resolver, y
   * el máximo de las reglas de validación ya lo trae la consulta.
   */
  async notasAbiertas(clienteId: number): Promise<AplicacionEditor[]> {
    const [pendientes, parciales] = await Promise.all(
      (['pendiente', 'parcial'] as const).map((estatus) =>
        firstValueFrom(
          this.http.get<Listado<NotaListada>>(`${API}/notas-remision`, {
            params: { cliente_id: clienteId, estatus, limite: 200 },
          }),
        ),
      ),
    );
    return [...pendientes.datos, ...parciales.datos]
      .sort((a, b) => a.folio.localeCompare(b.folio))
      .map((n) => ({
        nota_id: n.id,
        folio: n.folio,
        fecha: n.fecha,
        subtotal: n.subtotal,
        estatus: n.estatus as 'pendiente' | 'parcial',
        monto: '',
      }));
  }

  /** El listado de la tabla, con los filtros de una pantalla de cobros. */
  async listar(opciones: {
    buscar?: string;
    metodo?: MetodoPago;
    desde?: string;
    hasta?: string;
    limite?: number;
    offset?: number;
  }): Promise<Listado<PagoListado>> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
    };
    if (opciones.buscar) params['buscar'] = opciones.buscar;
    if (opciones.metodo) params['metodo'] = opciones.metodo;
    if (opciones.desde) params['desde'] = opciones.desde;
    if (opciones.hasta) params['hasta'] = opciones.hasta;
    return firstValueFrom(this.http.get<Listado<PagoListado>>(`${API}/pagos`, { params }));
  }

  /** El detalle con las aplicaciones. La usa "Ver" en la tabla. */
  async obtener(id: number): Promise<Pago> {
    return firstValueFrom(this.http.get<Pago>(`${API}/pagos/${id}`));
  }

  /** Crea el pago y devuelve el detalle como lo armó el sistema. */
  async crear(cuerpo: CuerpoPago): Promise<Pago> {
    return firstValueFrom(this.http.post<Pago>(`${API}/pagos`, cuerpo));
  }
}
