/** Tipos de inventario: la existencia por producto y almacen, y su kardex. */

/** Los tipos que se capturan a mano. `ver M_POSITIVO` en esquemas. */
export type TipoManual = 'ajuste_positivo' | 'ajuste_negativo' | 'merma';

/** Cualquier tipo del kardex, los manuales y los de compra/venta. */
export type TipoMovimiento = 'entrada_compra' | 'salida_venta' | TipoManual;

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

/** Un renglon del kardex, como lo trae el SQL. */
export interface FilaMovimiento {
  id: string;
  producto_id: string;
  producto_codigo: string;
  producto: string;
  almacen_id: number;
  almacen: string;
  fecha: Date | string;
  tipo: TipoMovimiento;
  cantidad_bultos: string;
  motivo: string | null;
  /** NULL en los ajustes y mermas; 'compra_detalle'/'nota_remision_detalle' en los automaticos. */
  referencia_tabla: string | null;
  creado_en: Date | string;
}

export interface Movimiento {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto: string;
  almacen_id: number;
  almacen: string;
  /** ISO con hora: es un movimiento, no un dia. */
  fecha: string;
  tipo: TipoMovimiento;
  /** Cantidad POSITIVA. El signo lo dice el tipo y lo arma el frontend. */
  cantidad_bultos: number;
  motivo: string | null;
  /** En los manuales siempre va `null`; los otros no se pueden borrar. */
  manual: boolean;
  creado_en: string;
}

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}
