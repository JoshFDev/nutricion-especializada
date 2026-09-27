/**
 * Formas de los precios.
 *
 * `FilaPrecioPublico` es lo que devuelve Postgres y `PrecioPublico` lo que
 * sale por la API. Como en productos, no son el mismo tipo:
 *
 * - `precio_kg` es NUMERIC y el driver lo entrega como string para no
 *   perder decimales. La API lo manda como number.
 * - `id`, `producto_id` y `cliente_id` son BIGINT y llegan como string.
 * - `vigente_desde` y `vigente_hasta` son DATE. El driver entrega un `Date`
 *   en hora local, y por eso el mapeo usa el año/mes/día locales en vez
 *   de `toISOString()`: un `toISOString()` sobre una fecha que Postgres
 *   guardo como 2026-06-01 puede devolver 2026-05-31T24:00 si la maquina
 *   esta en un huso negativo. Para una vigencia, un dia corrido es un dia
 *   de diferencia.
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

/**
 * La fecha como texto AAAA-MM-DD, taken de las partes LOCALES del Date.
 *
 * Ver la nota de la cabecera: un `toISOString()` aqui puede correr un dia.
 * Se escribe a mano en vez de usar `toLocaleDateString('en-CA')` porque
 * ese depende de los datos de ICU del runtime y en una imagen de Node
 * minimalista cambia el formato.
 */
const fechaComoTexto = (valor: Date): string => {
  const anio = valor.getFullYear();
  const mes = String(valor.getMonth() + 1).padStart(2, '0');
  const dia = String(valor.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
};

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
