/**
 * Formas del producto.
 *
 * `FilaProducto` es lo que devuelve Postgres y `Producto` lo que sale por
 * la API. No son el mismo tipo y no deberian serlo:
 *
 * - `presentacion_kg` es NUMERIC, y el driver lo entrega como string para
 *   no perder decimales. La API lo manda como number, porque NUMERIC(10,3)
 *   son 10 digitos y un double de 15-17 los aguanta sin problema, y al
 *   frontend le sirve mas un numero que un string.
 * - `id` es BIGINT y tambien llega como string, por lo mismo.
 * - Los timestamps son Date y salen como ISO 8601.
 *
 * `categoria` y `especie` son el nombre del catalogo resuelto con un JOIN.
 * Vienen anadidos para que la pantalla de productos no tenga que pedir el
 * catalogo entero y cruzarlo en el cliente.
 */

export interface FilaProducto {
  id: string;
  codigo: string;
  nombre: string;
  categoria_id: number | null;
  especie_id: number | null;
  categoria: string | null;
  especie: string | null;
  presentacion_kg: string;
  activo: boolean;
  creado_en: Date;
  actualizado_en: Date;
}

export interface Producto {
  id: number;
  codigo: string;
  nombre: string;
  categoria_id: number | null;
  especie_id: number | null;
  categoria: string | null;
  especie: string | null;
  presentacion_kg: number;
  activo: boolean;
  creado_en: string;
  actualizado_en: string;
}

export const mapeoProducto = (fila: FilaProducto): Producto => ({
  id: Number(fila.id),
  codigo: fila.codigo,
  nombre: fila.nombre,
  categoria_id: fila.categoria_id,
  especie_id: fila.especie_id,
  categoria: fila.categoria,
  especie: fila.especie,
  presentacion_kg: Number(fila.presentacion_kg),
  activo: fila.activo,
  creado_en: fila.creado_en.toISOString(),
  actualizado_en: fila.actualizado_en.toISOString(),
});
