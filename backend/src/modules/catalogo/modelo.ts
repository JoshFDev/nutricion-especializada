/**
 * Formas del catalogo.
 *
 * Especies y Categorias de Producto devuelven exactamente lo mismo, asi
 * que comparten tipo. `Especie` y `CategoriaProducto` se dejan como alias
 * para que el codigo que las use se lea en el idioma del negocio y no
 * como "entidad de catalogo".
 */

export interface FilaCatalogo {
  id: number;
  nombre: string;
}

export type Especie = FilaCatalogo;
export type CategoriaProducto = FilaCatalogo;

export const mapeoFila = (fila: FilaCatalogo): FilaCatalogo => ({
  id: fila.id,
  nombre: fila.nombre,
});
