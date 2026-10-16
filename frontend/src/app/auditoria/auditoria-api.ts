import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { hoyComoTexto } from '../precios/precios-api';

/**
 * Las cinco bitácoras, en solo lectura.
 *
 * Este módulo no permite escribir nada y por eso aquí tampoco hay ni un
 * formulario. No es que se haya olvidado: las reglas lo dicen ("aceptar una
 * operación que la escriba daría al usuario la forma de fabricar su propio
 * rastro") y la pantalla tiene que dejar claro que lo que se ve lo escribieron
 * las reglas automáticas del sistema, no las pantallas.
 *
 * Cada bitácora tiene su propio permiso (`auditoria.accesos`, `.caja`,
 * `.inventario`, `.precios`), y el de la pestaña es lo que decide si la
 * pestaña existe. Con `auditoria.ver` sin los otros cuatro se ve una sola
 * pestaña, y eso no es un error de permisos: es alguien a quien le pasaron el
 * acceso a la mínima información.
 *
 * Lo que hace propia a esta pantalla es el renglón del `log`: trae el registro
 * de ANTES y el de DESPUÉS en crudo, y el sistema no sabe qué tablas existen
 * ni qué campos tiene cada una. Por eso la pantalla arma el cambio ella misma
 * (`cambiosDeFila`): si el cálculo viviera en el sistema, habría que tocarlo
 * cada vez que se agregara una columna.
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
  /** Los datos de antes y los de después, tal cual los guardó la regla automática del sistema. */
  datos_anteriores: Record<string, unknown> | null;
  datos_nuevos: Record<string, unknown> | null;
}

export interface RenglonAcceso {
  id: number;
  fecha: string;
  evento: EventoAcceso;
  usuario_id: number | null;
  /** Lo que se tecleó en el campo de correo, exista o no la cuenta. */
  usuario_intento: string | null;
  usuario: string | null;
  usuario_rfc: string | null;
  ip: string | null;
  user_agent: string | null;
  detalle: string | null;
}

export interface RenglonCaja {
  id: number;
  /** Vacío cuando el renglón es de una baja: el movimiento ya no existe. */
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

/** El rango, igual para las cinco: dos días opcionales. */
export interface Rango {
  desde?: string;
  hasta?: string;
}

export interface Filtros extends Rango {
  buscar?: string;
  limite?: number;
  offset?: number;
}

// ------------------------------------------------------------------ el log

/** Un campo que se movió entre el renglón anterior y el nuevo. */
export interface Cambio {
  campo: string;
  antes: string;
  nuevo: string;
  /** El campo no existía antes, o no existe después. */
  lado?: 'antes' | 'despues';
}

/**
 * Cómo se muestra un valor de los datos de la regla automática.
 *
 * La regla guarda lo que hay en la fila y el sistema devuelve los importes y
 * las fechas como texto, y los booleanos como `true`/`false`. Aquí solo se
 * quiere una línea legible, no una revisión de tipos: un `"12.50"` y un `12.5`
 * se pintan igual y a quien lee la bitácora le sirve el número, no el tipo de
 * la columna.
 */
export function valorLegible(valor: unknown): string {
  if (valor === null || valor === undefined) return '—';
  if (typeof valor === 'boolean') return valor ? 'sí' : 'no';
  if (typeof valor === 'number') return String(valor);
  if (typeof valor === 'string') return valor === '' ? '(vacío)' : valor;
  if (Array.isArray(valor)) return valor.length === 0 ? '—' : valor.map(valorLegible).join(', ');
  return JSON.stringify(valor);
}

/**
 * Los campos que SE MOVIERON, en el orden en que están en el registro nuevo.
 *
 * Es lo que hace útil la bitácora: cientos de columnas de las que solo
 * cambiaron dos. Solo van los que cambian, y se comparan ya pasadas por
 * `valorLegible` para que `null` contra `''` se vea como lo que es (un campo
 * que se vació) y no como dos valores raros.
 *
 * Los campos que solo existen en un lado se marcan con `lado` para que la
 * tabla pueda distinguir "se llenó" de "cambió de valor": en un alta todo es
 * nuevo y esa es la única lectura útil.
 */
export function cambiosDeFila(
  anterior: Record<string, unknown> | null,
  nuevo: Record<string, unknown> | null,
): Cambio[] {
  const antes = anterior ?? {};
  const despues = nuevo ?? {};
  const claves = Object.keys(despues).length > 0 ? Object.keys(despues) : Object.keys(antes);
  const cambios: Cambio[] = [];

  for (const campo of claves) {
    const valorAntes = antes[campo];
    const valorDespues = despues[campo];
    if (valorAntes === valorDespues) continue;
    cambios.push({
      campo,
      antes: valorLegible(valorAntes),
      nuevo: valorLegible(valorDespues),
      lado: valorAntes === undefined ? 'antes' : valorDespues === undefined ? 'despues' : undefined,
    });
  }
  return cambios;
}

// ------------------------------------------------------------- los nombres

/** El evento de acceso, en palabras. */
export const ETIQUETA_EVENTO: Record<EventoAcceso, string> = {
  login_exitoso: 'Entró bien',
  login_fallido: 'Falló al entrar',
  logout: 'Cerró sesión',
  acceso_denegado: 'Le negaron el acceso',
  cambio_contrasena: 'Cambió su clave',
  bloqueo: 'Cuenta bloqueada',
  desbloqueo: 'Cuenta desbloqueada',
  usuario_creado: 'Se dio de alta',
  usuario_desactivado: 'Se desactivó',
};

/**
 * Si un evento es de los que hay que mirar primero.
 *
 * `login_fallido`, `acceso_denegado` y `bloqueo` son los que aparecen cuando
 * alguien que no debería está intentando entrar. Van marcados en la columna
 * para que la lista se pueda recorrer sin leer cada renglón, que es como se lee
 * una bitácora: uno escanea, no lee línea por línea.
 */
export function eventoSospechoso(evento: EventoAcceso): boolean {
  return evento === 'login_fallido' || evento === 'acceso_denegado' || evento === 'bloqueo';
}

export const ETIQUETA_OPERACION: Record<Operacion, string> = {
  INSERT: 'Alta',
  UPDATE: 'Cambio',
  DELETE: 'Baja',
};

/*
 * ------------------------------------------------------------- los codigos
 *
 * La base guarda codigos y la bitacora los enseña tal cual: `salida_venta`,
 * `efectivo`, `publico`, `inventario_movimientos`. Quien revisa la bitacora es
 * la persona que lleva el negocio, no quien escribio las tablas, y
 * `salida_venta` no le dice si vendio o si le devolvieron algo. Aqui se traduce
 * cada codigo a la frase que usa el resto de la aplicacion.
 *
 * Lo que no este en las tablas NO desaparece: se le quitan los guiones bajos y
 * se le pone la primera letra en mayuscula (`humanizar`). Asi un codigo nuevo
 * del sistema se lee igual de bien aunque nadie se acuerde de agregarlo aqui, y
 * la pantalla nunca enseña `algo_raro` en crudo.
 */

/** El tipo de movimiento de inventario. */
const ETIQUETA_TIPO_INVENTARIO: Record<string, string> = {
  entrada_compra: 'Compra',
  salida_venta: 'Venta',
  ajuste_positivo: 'Ajuste que sube',
  ajuste_negativo: 'Ajuste que baja',
  merma: 'Merma',
};

export function tipoInventarioLegible(tipo: string): string {
  return ETIQUETA_TIPO_INVENTARIO[tipo] ?? humanizar(tipo);
}

/** El tipo de precio: los mismos tres nombres que usa el filtro de la pestaña. */
export const ETIQUETA_TIPO_PRECIO: Record<'cliente' | 'publico' | 'costo', string> = {
  cliente: 'Precio de cliente',
  publico: 'Precio de lista',
  costo: 'Costo',
};

export function tipoPrecioLegible(tipo: 'cliente' | 'publico' | 'costo'): string {
  return ETIQUETA_TIPO_PRECIO[tipo];
}

/** Efectivo o banco, el tipo de cuenta del movimiento de caja. */
export const ETIQUETA_TIPO_CUENTA: Record<'efectivo' | 'banco', string> = {
  efectivo: 'Efectivo',
  banco: 'Banco',
};

export function tipoCuentaLegible(tipo: 'efectivo' | 'banco'): string {
  return ETIQUETA_TIPO_CUENTA[tipo];
}

/**
 * El nombre de una tabla del log, en palabras.
 *
 * Es lo que se lee en la columna "Qué" y en el titulo del detalle. Las tablas
 * con regla de auditoria son las de `db/migrations`; `inventario_movimientos`
 * es la unica respuesta que sabe dar la base, y quien abre la bitacora piensa
 * en "Inventario".
 */
const ETIQUETA_TABLA: Record<string, string> = {
  usuarios: 'Usuarios',
  usuarios_roles: 'Permisos de usuario',
  clientes: 'Clientes',
  precios_cliente: 'Precios de cliente',
  precios_publicos: 'Precios de lista',
  notas_remision: 'Notas de remisión',
  nota_remision_detalle: 'Renglones de nota',
  pagos: 'Pagos',
  pagos_aplicacion: 'Pagos aplicados',
  inventario_movimientos: 'Inventario',
  movimientos_financieros: 'Caja y bancos',
  facturas: 'Facturas',
  factura_nota: 'Facturas y notas',
  compras: 'Compras',
  compra_detalle: 'Renglones de compra',
};

export function tablaLegible(tabla: string): string {
  return ETIQUETA_TABLA[tabla] ?? humanizar(tabla);
}

/**
 * El nombre de una columna del detalle, en palabras.
 *
 * El detalle compara el registro de antes contra el de despues, campo por
 * campo, y los campos son columnas: `precio_anterior`, `vigente_desde`,
 * `motivo_cancelacion`. Se traducen los que no se entienden solos y el resto se
 * humana; una columna que termina en `_id` se marca como numero, porque el
 * valor que trae es el id y no el nombre de la cosa.
 */
const ETIQUETA_CAMPO: Record<string, string> = {
  id: 'Número',
  creado_en: 'Cuándo se creó',
  actualizado_en: 'Cuándo se actualizó',
  contrasena: 'Contraseña',
  motivo_cancelacion: 'Motivo de cancelación',
  forma_pago: 'Forma de pago',
  limite_credito: 'Límite de crédito',
  dias_credito: 'Días de crédito',
  cantidad_bultos: 'Cantidad (bultos)',
  vigente_desde: 'Vigente desde',
  vigente_hasta: 'Vigente hasta',
  fondo_login: 'Fondo de la pantalla de entrada',
  fondo_establo: 'Fondo del establo',
};

export function campoLegible(campo: string): string {
  return ETIQUETA_CAMPO[campo] ?? humanizar(campo, true);
}

/**
 * Un identificador de la base en palabras.
 *
 * `precio_anterior` es "Precio anterior" y no "Precio_anterior". Con
 * `conNumero`, los que terminan en `_id` llevan "(número)" para no prometer el
 * nombre de la cosa cuando lo que se esta enseñando es su id.
 */
function humanizar(texto: string, conNumero = false): string {
  const esId = conNumero && texto.endsWith('_id');
  const base = esId ? texto.slice(0, -3) : texto;
  const palabras = base.replace(/_/g, ' ').trim();
  const titulo = palabras.charAt(0).toUpperCase() + palabras.slice(1);
  return esId ? `${titulo} (número)` : titulo;
}

/**
 * La fecha de la bitácora: día y hora.
 *
 * Se corta el texto tal cual y no con `new Date` a propósito: el navegador lo
 * correría a la zona horaria de quien la abre, y un renglón de las 00:15 se
 * vería del día anterior (o del siguiente) al otro lado del país.
 */
export function fechaLegible(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/**
 * El rango por omisión: el mes que va.
 *
 * Una bitácora sin rango son miles de renglones y la primera pregunta de quien
 * la abre es "qué pasó hoy", así que el filtro arranca en el mes en curso. Se
 * puede limpiar con "Todo" para ir a buscar algo viejo, y las fechas viajan
 * como `AAAA-MM-DD` porque el servicio las convierte a un fin de día
 * EXCLUSIVO (`< fecha + 1`): es lo que hace que el día final no desaparezca
 * del reporte.
 */
export function rangoDelMes(hoy = new Date()): Rango {
  const dia = hoyComoTexto(hoy);
  return { desde: `${dia.slice(0, 7)}-01`, hasta: dia };
}

/**
 * Si el rango tiene sentido, para no hacer un viaje que va a rebotar.
 *
 * El sistema ya lo revisa (`rangoCoherente` en `auditoria/esquemas.ts`) y
 * devuelve 422. Preguntar aquí es solo para que el botón se apague con el
 * motivo a la vista, y se compara como texto: con `AAAA-MM-DD` el orden
 * alfabético es el del calendario, y `new Date` correría a la zona horaria del
 * navegador.
 */
export function rangoIncoherente(desde?: string, hasta?: string): boolean {
  if (desde === undefined || hasta === undefined) return false;
  return desde > hasta;
}

@Injectable({ providedIn: 'root' })
export class AuditoriaApi {
  private readonly http = inject(HttpClient);

  /**
   * Las cinco llamadas son consultas con filtros y paginación, y solo cambian
   * la ruta y los filtros propios de cada una. Se arman los parámetros a mano
   * en cada método (y no con un objeto plano) porque varias bitácoras NO
   * aceptan búsqueda: mandarle `buscar` a la de caja es un 400 de las reglas
   * de validación, no un filtro que se ignore.
   */
  private async listar<T>(
    ruta: string,
    params: Record<string, string | number>,
  ): Promise<Listado<T>> {
    return firstValueFrom(this.http.get<Listado<T>>(`${API}/auditoria/${ruta}`, { params }));
  }

  /** Los cambios de cualquier tabla, con el registro de antes y el de ahora. */
  async log(
    opciones: Filtros & { tabla?: string; operacion?: Operacion | null },
  ): Promise<Listado<RenglonLog>> {
    const params = this.comunes(opciones);
    if (opciones.tabla) params['tabla'] = opciones.tabla;
    if (opciones.operacion) params['operacion'] = opciones.operacion;
    return this.listar<RenglonLog>('log', params);
  }

  /** Quién entró, con quién falló y a quién se le negó el paso. */
  async accesos(
    opciones: Filtros & { evento?: EventoAcceso | null },
  ): Promise<Listado<RenglonAcceso>> {
    const params = this.comunes(opciones);
    if (opciones.evento) params['evento'] = opciones.evento;
    return this.listar<RenglonAcceso>('accesos', params);
  }

  /** Los movimientos de caja y bancos, con el saldo antes y después. */
  async caja(
    opciones: Filtros & { tipo?: 'ingreso' | 'egreso' | null },
  ): Promise<Listado<RenglonCaja>> {
    const params = this.comunes(opciones, false);
    if (opciones.tipo) params['tipo'] = opciones.tipo;
    return this.listar<RenglonCaja>('caja', params);
  }

  /** Los movimientos de almacén, con la existencia antes y después. */
  async inventario(opciones: Filtros): Promise<Listado<RenglonInventario>> {
    return this.listar<RenglonInventario>('inventario', this.comunes(opciones, false));
  }

  /** Los cambios de precio, con la variación en moneda. */
  async precios(
    opciones: Filtros & { tipo_precio?: 'cliente' | 'publico' | 'costo' | null },
  ): Promise<Listado<RenglonPrecios>> {
    const params = this.comunes(opciones, false);
    if (opciones.tipo_precio) params['tipo_precio'] = opciones.tipo_precio;
    return this.listar<RenglonPrecios>('precios', params);
  }

  /**
   * Los filtros que las cinco comparten.
   *
   * `conBusqueda` está apagado para caja, inventario y precios porque sus
   * reglas de validación no la aceptan (`buscar` solo existe en el log y en
   * accesos) y mandarla sería un 400. Los ids de filtro (`cuenta_id`,
   * `producto_id`, `almacen_id`, `usuario_id`) no se exponen todavía: llegan
   * vacíos y la pantalla filtra por nombre y por fecha, que es como se pregunta
   * primero.
   */
  private comunes(opciones: Filtros, conBusqueda = true): Record<string, string | number> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
    };
    if (opciones.desde) params['desde'] = opciones.desde;
    if (opciones.hasta) params['hasta'] = opciones.hasta;
    if (conBusqueda && opciones.buscar) params['buscar'] = opciones.buscar;
    return params;
  }
}
