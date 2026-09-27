/** Tipos de inventario: la existencia por producto y almacen. */

export interface Existencia {
  producto_id: number;
  producto_codigo: string;
  producto: string;
  almacen_id: number;
  almacen: string;
  /** En BULTOS, que es la unidad con la que se compra y se vende. */
  existencia_bultos: number;
  producto_activo: boolean;
}

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}
