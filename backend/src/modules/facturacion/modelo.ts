/**
 * Tipos de facturacion.
 *
 * `facturas.id` es BIGINT y `monto_total` es NUMERIC, asi que los dos llegan
 * como `string` del driver. `fecha` es DATE: el driver la entrega como `Date`
 * a medianoche local, y por eso el mapper pasa por `fechaComoTexto`.
 */

export type EstatusFactura = 'solicitada' | 'emitida' | 'cancelada';

export interface FilaFactura {
  id: string;
  cliente_id: string;
  cliente_nombre: string;
  fecha: Date | string;
  metodo_pago: string | null;
  monto_total: string;
  estatus: EstatusFactura;
  motivo_cancelacion: string | null;
  creado_en: Date;
}

export interface NotaFacturada {
  nota_id: number;
  nota: string;
  fecha: string;
  subtotal: number;
  estatus: string;
}

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

export interface FacturaListada {
  id: number;
  cliente_id: number;
  cliente: string;
  fecha: string;
  metodo_pago: string | null;
  monto_total: number;
  estatus: EstatusFactura;
  notas: number;
  cancelada: boolean;
}

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}
