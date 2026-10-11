/**
 * Tipos de reportes.
 *
 * El modulo es de SOLO LECTURA: las tres consultas salen de las vistas de
 * 0001 (`vw_existencia_actual`, `vw_consumo_semanal_promedio` y
 * `vw_estado_cuenta_cliente`), que ya traen los nombres resueltos, asi que
 * aqui no hay ningun tipo de alta, edicion ni borrado. Un reporte que se
 * pueda escribir deja de ser un reporte.
 *
 * A diferencia de la auditoria, aqui SI se usa la vista y no la tabla base:
 * en auditoria hacia falta el id para filtrar, y aqui los ids tambien hacen
 * falta, pero las tres vistas ya los traen (`producto_id`, `cliente_id`,
 * `almacen_id`). Leer la vista es leer una sola definicion en vez de repetir
 * los JOINs en cada consulta.
 */

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** Una fila de `vw_existencia_actual`: lo que hay de un producto en una bodega. */
export interface RenglonExistencia {
  producto_id: number;
  codigo: string;
  producto: string;
  almacen_id: number;
  almacen: string;
  /**
   * Los bultos que hay. Es el resultado de sumar el kardex, no una columna
   * guardada, y por eso puede salir NEGATIVO mientras no se haga el conteo
   * fisico (una venta capturada antes que su compra). El reporte no lo esconde:
   * un negativo en el papel es justo lo que hay que ir a revisar.
   */
  existencia_bultos: number;
}

/** Una fila de `vw_consumo_semanal_promedio`. */
export interface RenglonConsumo {
  cliente_id: number;
  cliente: string;
  producto_id: number;
  producto: string;
  /** Los kilos por semana en promedio de las ultimas 8 semanas. */
  kg_promedio_semanal: number;
}

/** Una fila de `vw_estado_cuenta_cliente`. */
export interface RenglonEstadoCuenta {
  cliente_id: number;
  cliente: string;
  saldo_actual: number;
  /** La fecha de su ultima venta, o NULL si nunca se le ha vendido. */
  ultima_venta: string | null;
  /** La fecha de su ultimo pago, o NULL si nunca ha abonado. */
  ultimo_pago: string | null;
}
