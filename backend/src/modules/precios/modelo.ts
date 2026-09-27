import { fechaComoTexto } from '../../core/valores.js';

/**
 * Formas de los precios.
 *
 * `FilaPrecioPublico` es lo que devuelve Postgres y `PrecioPublico` lo que
 * sale por la API. Como en productos, no son el mismo tipo:
 *
 * - `precio_kg` es NUMERIC y el driver lo entrega como string para no
 *   perder decimales. La API lo manda como number.
 * - `id`, `producto_id` y `cliente_id` son BIGINT y llegan como string.
 * - `vigente_desde` y `vigente_hasta` son DATE y el mapeo pasa por
 *   `fechaComoTexto` de `core/valores.ts`, que explica por que se leen las
 *   partes locales del `Date` en vez de usar `toISOString()`.
 */

/** `vigente_hasta` en NULL es "abierto": la fila sigue vigente. */
export interface FilaPrecioPublico {
  id: string;
  producto_id: string;
  producto_codigo: string;
  producto_nombre: string;
  precio_kg: string;
  vigente_desde: Date;
  vigente_hasta: Date | null;
}

export interface FilaPrecioCliente {
  id: string;
  cliente_id: string;
  producto_id: string;
  producto_codigo: string;
  producto_nombre: string;
  cliente_nombre: string;
  precio_kg: string;
  vigente_desde: Date;
  vigente_hasta: Date | null;
}

export interface PrecioPublico {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  precio_kg: number;
  vigente_desde: string;
  vigente_hasta: string | null;
}

export interface PrecioCliente {
  id: number;
  cliente_id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  cliente_nombre: string;
  precio_kg: number;
  vigente_desde: string;
  vigente_hasta: string | null;
}

export const mapeoPrecioPublico = (fila: FilaPrecioPublico): PrecioPublico => ({
  id: Number(fila.id),
  producto_id: Number(fila.producto_id),
  producto_codigo: fila.producto_codigo,
  producto_nombre: fila.producto_nombre,
  precio_kg: Number(fila.precio_kg),
  vigente_desde: fechaComoTexto(fila.vigente_desde),
  vigente_hasta: fila.vigente_hasta ? fechaComoTexto(fila.vigente_hasta) : null,
});

export const mapeoPrecioCliente = (fila: FilaPrecioCliente): PrecioCliente => ({
  id: Number(fila.id),
  cliente_id: Number(fila.cliente_id),
  producto_id: Number(fila.producto_id),
  producto_codigo: fila.producto_codigo,
  producto_nombre: fila.producto_nombre,
  cliente_nombre: fila.cliente_nombre,
  precio_kg: Number(fila.precio_kg),
  vigente_desde: fechaComoTexto(fila.vigente_desde),
  vigente_hasta: fila.vigente_hasta ? fechaComoTexto(fila.vigente_hasta) : null,
});
