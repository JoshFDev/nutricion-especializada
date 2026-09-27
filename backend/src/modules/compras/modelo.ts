import { fechaComoTexto } from '../../core/valores.js';

/**
 * Tipos de compras: lo que devuelve Postgres y lo que sale por la API.
 *
 * `creado_en` es TIMESTAMP (no DATE) y llega como Date de JavaScript, a
 * diferencia de `fecha`, que es DATE y llega como texto. Por eso una usa
 * `toISOString()`, y las dos usan `fechaComoTexto` de `core/valores.ts`.
 */

export type EstatusCompra = 'pendiente' | 'parcial' | 'pagada' | 'cancelada';

export interface FilaCompra {
  id: string;
  proveedor_id: string;
  proveedor_nombre: string;
  fecha: string;
  folio_proveedor: string | null;
  monto_total: string;
  estatus: EstatusCompra;
  motivo_cancelacion: string | null;
  creado_en: Date;
}

export interface FilaRenglonCompra {
  id: string;
  producto_id: string;
  producto_codigo: string;
  producto_nombre: string;
  almacen_id: number;
  almacen_nombre: string;
  cantidad_bultos: string;
  kg_bulto: string;
  precio_kg: string;
  subtotal: string;
}

export interface Compra {
  id: number;
  proveedor_id: number;
  proveedor: string;
  fecha: string;
  folio_proveedor: string | null;
  monto_total: number;
  estatus: EstatusCompra;
  motivo_cancelacion: string | null;
  creado_en: string;
  renglones: RenglonCompra[];
}

export interface RenglonCompra {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  almacen_id: number;
  almacen: string;
  cantidad_bultos: number;
  kg_bulto: number;
  precio_kg: number;
  subtotal: number;
}

export interface CompraListada {
  id: number;
  proveedor_id: number;
  proveedor: string;
  fecha: string;
  folio_proveedor: string | null;
  monto_total: number;
  estatus: EstatusCompra;
  renglones: number;
}

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

export const mapearCompra = (f: FilaCompra, renglones: RenglonCompra[] = []): Compra => ({
  id: Number(f.id),
  proveedor_id: Number(f.proveedor_id),
  proveedor: f.proveedor_nombre,
  fecha: fechaComoTexto(f.fecha),
  folio_proveedor: f.folio_proveedor,
  monto_total: Number(f.monto_total),
  estatus: f.estatus,
  motivo_cancelacion: f.motivo_cancelacion,
  creado_en: f.creado_en.toISOString(),
  renglones,
});

export const mapearRenglonCompra = (f: FilaRenglonCompra): RenglonCompra => ({
  id: Number(f.id),
  producto_id: Number(f.producto_id),
  producto_codigo: f.producto_codigo,
  producto_nombre: f.producto_nombre,
  almacen_id: f.almacen_id,
  almacen: f.almacen_nombre,
  cantidad_bultos: Number(f.cantidad_bultos),
  kg_bulto: Number(f.kg_bulto),
  precio_kg: Number(f.precio_kg),
  subtotal: Number(f.subtotal),
});
