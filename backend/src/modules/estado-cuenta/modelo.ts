/**
 * Tipos del estado de cuenta por cliente.
 *
 * El modulo reemplaza la pantalla de facturacion en el menu (migracion 0017)
 * y hace dos cosas: listar a los clientes con su saldo, y dejar bajar la hoja
 * de estado de cuenta de UN cliente como `EstadoCuentaCliente.xlsx`.
 *
 * Los nombres se mantienen en el dominio: `RenglonEstadoCuenta` es la fila
 * del listado y `HojaCliente` es lo que se vierte en el Excel de la plantilla.
 */

/** Una fila del listado de clientes: cuanto debe y cuando se movio por ultima vez. */
export interface RenglonEstadoCuenta {
  cliente_id: number;
  cliente: string;
  saldo_actual: number;
  ultima_venta: string | null;
  ultimo_pago: string | null;
}

/** La forma `Listado` que devuelve toda la API. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/**
 * Un movimiento en la hoja: una venta (columna B, C, D) o un abono
 * (columna E, F, G).
 *
 * `fecha` ya viaja en el formato del papel ("DD-MM-AAAA"). `folio` y
 * `metodo` son opcionales porque cada tipo de movimiento llena otra columna:
 * la venta trae folio, el abono trae metodo de pago, y los dos traen `monto`.
 */
export interface Movimiento {
  fecha: string;
  esAbono: boolean;
  folio?: string;
  metodo?: string;
  monto: number;
}

/** Todo lo que el Excel de estado de cuenta necesita para llenarse. */
export interface HojaCliente {
  cliente_id: number;
  cliente: string;
  movimientos: Movimiento[];
  renglones?: RenglonHoja[];
}
/**
 * Un renglon de la hoja: puede contener una venta y un abono aplicado a la misma nota.
 */
export interface RenglonHoja {
  fecha: string;
  esVenta: boolean;
  folio?: string;
  montoVenta?: number;
  esAbono: boolean;
  metodoAbono?: string | null;
  montoAbono?: number;
}
