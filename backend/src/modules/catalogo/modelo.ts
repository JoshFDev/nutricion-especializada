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

/**
 * Una fila del LISTADO, con cuantos registros la apuntan.
 *
 * Solo el listado lo trae. Es lo que permite el filtro "En uso / Sin uso"
 * del frontend: sin el, el catalogo no tiene por donde filtrarse, porque
 * lo unico que se puede buscar por texto es el nombre y el nombre no
 * dice si esa categoría la usan tres productos o ninguno.
 */
export interface FilaCatalogoConUsos extends FilaCatalogo {
  /** Suma de las filas que la referencian (productos, clientes). */
  usos: number;
}

export type Especie = FilaCatalogo;
export type CategoriaProducto = FilaCatalogo;

export const mapeoFila = (fila: FilaCatalogo): FilaCatalogo => ({
  id: fila.id,
  nombre: fila.nombre,
});

export const mapeoFilaConUsos = (fila: FilaCatalogoConUsos): FilaCatalogoConUsos => ({
  id: fila.id,
  nombre: fila.nombre,
  usos: fila.usos,
});
