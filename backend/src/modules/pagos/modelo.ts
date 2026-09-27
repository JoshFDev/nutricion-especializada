import { fechaComoTexto } from '../../core/valores.js';
import { componerFolio, type EstatusNota } from '../notas-remision/modelo.js';

/**
 * Tipos de pagos: lo que devuelve Postgres y lo que sale por la API.
 *
 * Los tipos de la base usan `string` para BIGINT, NUMERIC y DATE porque
 * `pg` no los convierte solo, por lo mismo que en notas de remision.
 */

export type MetodoPago = 'Efectivo' | 'Transferencia' | 'Depósito';

export interface FilaPago {
  id: string;
  cliente_id: string;
  cliente_nombre: string;
  fecha: string;
  metodo: MetodoPago | null;
  monto: string;
  monto_aplicado: string;
  requiere_factura: boolean;
  referencia: string | null;
  creado_en: Date;
}

/** Una aplicacion con lo de la nota que se esta cobrando. */
export interface FilaAplicacion {
  id: string;
  pago_id: string;
  nota_id: string;
  monto_aplicado: string;
  nota_serie: string;
  nota_folio_numero: number;
  nota_subtotal: string;
  nota_estatus: EstatusNota;
}

/** La nota tal como la necesita el servicio para decidir si se puede cobrar. */
export interface NotaCobrable {
  id: number;
  cliente_id: number;
  subtotal: number;
  estatus: EstatusNota;
  folio: string;
}

/** Lo que sale por la API. */
export interface Pago {
  id: number;
  cliente_id: number;
  cliente: string;
  fecha: string;
  metodo: MetodoPago | null;
  monto: number;
  monto_aplicado: number;
  /**
   * Lo que se recibio y todavia no esta aplicado a ninguna nota.
   *
   * Es dinero real de la empresa, no un dato sobrante: se descuenta del
   * saldo del cliente (lo hace `fn_recalcular_saldo_cliente`) asi que
   * tiene que estar visible, o el operador no sabe que hay un abono
   * flotando sin destino.
   */
  saldo: number;
  requiere_factura: boolean;
  referencia: string | null;
  creado_en: string;
  aplicaciones: AplicacionPago[];
}

export interface AplicacionPago {
  id: number;
  nota_id: number;
  nota: string;
  monto: number;
  /** El estatus de la nota DESPUES de aplicar: 'parcial' o 'pagada'. */
  nota_estatus: EstatusNota;
}

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

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

export const mapearPago = (f: FilaPago, aplicaciones: AplicacionPago[] = []): Pago => ({
  id: Number(f.id),
  cliente_id: Number(f.cliente_id),
  cliente: f.cliente_nombre,
  fecha: fechaComoTexto(f.fecha),
  metodo: f.metodo,
  monto: Number(f.monto),
  monto_aplicado: Number(f.monto_aplicado),
  saldo: Number((Number(f.monto) - Number(f.monto_aplicado)).toFixed(2)),
  requiere_factura: f.requiere_factura,
  referencia: f.referencia,
  creado_en: f.creado_en.toISOString(),
  aplicaciones,
});

export const mapearAplicacion = (f: FilaAplicacion): AplicacionPago => ({
  id: Number(f.id),
  nota_id: Number(f.nota_id),
  // El folio se compone con el helper de notas, no con un CONCAT aqui:
  // el formato "A-1001" tiene una sola definicion en todo el sistema.
  nota: componerFolio(f.nota_serie, f.nota_folio_numero),
  monto: Number(f.monto_aplicado),
  nota_estatus: f.nota_estatus,
});
