/**
 * Tipos de caja y bancos.
 *
 * `cuentas_financieras.id` y `movimientos_financieros.cuenta_id` son SMALLINT
 * (la tabla es `SMALLSERIAL`), asi que el driver los entrega como `number` y
 * no como `string`: el `Number(...)` de los mappers es por lo unico que si
 * necesita conversion son los BIGINT y los NUMERIC.
 */

export type TipoCuenta = 'efectivo' | 'banco';
export type TipoMovimiento = 'ingreso' | 'egreso';

export interface FilaCuenta {
  id: number;
  nombre: string;
  tipo: TipoCuenta;
  banco: string | null;
  titular: string | null;
  saldo_actual: string;
}

export interface FilaMovimiento {
  id: string;
  cuenta_id: number;
  fecha: Date | string;
  tipo: TipoMovimiento;
  categoria: string;
  cliente_id: string | null;
  proveedor_id: string | null;
  monto: string;
  descripcion: string | null;
  tiene_factura: boolean;
  creado_en: Date;
  cuenta_nombre: string;
  cuenta_tipo: TipoCuenta;
  cliente_nombre: string | null;
  proveedor_nombre: string | null;
}

export interface Cuenta {
  id: number;
  nombre: string;
  tipo: TipoCuenta;
  banco: string | null;
  titular: string | null;
  saldo_actual: number;
}

export interface Movimiento {
  id: number;
  cuenta_id: number;
  cuenta: string;
  cuenta_tipo: TipoCuenta;
  fecha: string;
  tipo: TipoMovimiento;
  categoria: string;
  cliente_id: number | null;
  cliente: string | null;
  proveedor_id: number | null;
  proveedor: string | null;
  monto: number;
  descripcion: string | null;
  tiene_factura: boolean;
  creado_en: string;
}

export interface MovimientoListado {
  id: number;
  cuenta_id: number;
  cuenta: string;
  fecha: string;
  tipo: TipoMovimiento;
  categoria: string;
  cliente: string | null;
  proveedor: string | null;
  monto: number;
  tiene_factura: boolean;
}

/**
 * El periodo por cuenta.
 *
 * `saldo_periodo` NO es el saldo de la cuenta: es lo que entro menos lo que
 * salio DENTRO del rango. Son dos preguntas distintas y confundirlas es como
 * se cuadra mal un dia -- el saldo de la cuenta arrastra todo lo anterior,
 * y el periodo es solo lo que paso hoy.
 */
export interface ResumenCuenta {
  cuenta_id: number;
  cuenta: string;
  tipo: TipoCuenta;
  ingresos: number;
  egresos: number;
  saldo_periodo: number;
  saldo_actual: number;
  movimientos: number;
}

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}
