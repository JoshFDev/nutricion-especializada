/**
 * Tipos de auditoria.
 *
 * Todas las tablas de bitacora se leen por sus vistas (`vw_auditoria_*` de
 * 0001), que ya traen nombres en vez de ids. Estas son solo de lectura: no
 * hay ningun tipo de escritura en este archivo a proposito.
 *
 * Cada renglon trae LOS DOS: el nombre para pintar y el id para enlazar. El
 * nombre es lo que se lee; el id es lo que hace falta para abrir el registro
 * que se movio, y para que un filtro por `usuario_id` o `producto_id` pueda
 * devolver filas y el frontend pueda saber cuales son. Las vistas no lo dan
 * (ver la nota de `repositorio.ts`), asi que el repositorio arma el nombre y
 * el id desde la tabla.
 */

export type Operacion = 'INSERT' | 'UPDATE' | 'DELETE';

export type EventoAcceso =
  | 'login_exitoso'
  | 'login_fallido'
  | 'logout'
  | 'acceso_denegado'
  | 'cambio_contrasena'
  | 'bloqueo'
  | 'desbloqueo'
  | 'usuario_creado'
  | 'usuario_desactivado';

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** Una fila de `auditoria_log`. */
export interface RenglonLog {
  id: number;
  fecha: string;
  tabla: string;
  operacion: Operacion;
  registro_id: number | null;
  usuario_id: number | null;
  usuario: string | null;
  usuario_rfc: string | null;
  usuario_ip: string | null;
  /**
   * El JSON anterior y el nuevo, tal cual los guardo `fn_auditoria`.
   *
   * Viene sin transformar: la idea es que la pantalla de "ver cambios"
   * pueda enlistar los campos que se movieron sin que el backend tenga que
   * saber que tablas existen y cuales no.
   */
  datos_anteriores: Record<string, unknown> | null;
  datos_nuevos: Record<string, unknown> | null;
}

/** Una fila de `auditoria_accesos`. */
export interface RenglonAcceso {
  id: number;
  fecha: string;
  evento: EventoAcceso;
  usuario_id: number | null;
  /** Lo que se tecleo en el campo de correo, exista o no la cuenta. */
  usuario_intento: string | null;
  usuario: string | null;
  usuario_rfc: string | null;
  ip: string | null;
  user_agent: string | null;
  detalle: string | null;
}

/** Una fila de `auditoria_caja`. */
export interface RenglonCaja {
  id: number;
  /**
   * El movimiento que se capturo. Sale en NULL cuando el renglon es de un
   * DELETE, porque el movimiento ya no existe y la FK de `auditoria_caja` no
   * lo guardo. Es `fn_auditar_caja` (0001) el que lo pone en NULL, y por eso
   * esta es la unica bitacora donde el rastro se queda sin enlace.
   */
  movimiento_id: number | null;
  cuenta_id: number;
  usuario_id: number | null;
  fecha: string;
  operacion: Operacion;
  tipo: 'ingreso' | 'egreso';
  categoria: string;
  monto: number;
  saldo_antes: number | null;
  saldo_despues: number | null;
  descripcion: string | null;
  cuenta: string;
  cuenta_tipo: 'efectivo' | 'banco';
  cliente: string | null;
  proveedor: string | null;
  usuario: string;
  creado_en: string;
}

/** Una fila de `auditoria_inventario`. */
export interface RenglonInventario {
  id: number;
  producto_id: number;
  almacen_id: number;
  usuario_id: number | null;
  fecha: string;
  operacion: Operacion;
  tipo: string;
  cantidad_bultos: number;
  existencia_antes: number | null;
  existencia_despues: number | null;
  motivo: string | null;
  producto_codigo: string;
  producto: string;
  almacen: string;
  usuario: string;
  creado_en: string;
}

/** Una fila de `auditoria_precios`. */
export interface RenglonPrecios {
  id: number;
  producto_id: number;
  cliente_id: number | null;
  proveedor_id: number | null;
  usuario_id: number | null;
  fecha: string;
  operacion: Operacion;
  tipo_precio: 'cliente' | 'publico' | 'costo';
  precio_anterior: number | null;
  precio_nuevo: number | null;
  variacion: number | null;
  producto_codigo: string;
  producto: string;
  cliente: string | null;
  proveedor: string | null;
  usuario: string;
  motivo: string | null;
  creado_en: string;
}
