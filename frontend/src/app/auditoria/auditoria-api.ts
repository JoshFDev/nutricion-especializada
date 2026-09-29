import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { hoyComoTexto } from '../precios/precios-api';

/**
 * Las cinco bitacoras, en solo lectura.
 *
 * Este modulo no tiene ni un `POST` y por eso aqui tampoco hay ni un
 * formulario. No es que se haya olvidado: `auditoria/esquemas.ts` lo dice
 * ("aceptar un endpoint que la escriba daria al usuario la forma de fabricar
 * su propio rastro") y la pantalla tiene que dejar claro que lo que se ve
 * lo escribieron los triggers de la base, no las pantallas.
 *
 * Cada bitacora tiene su propio permiso (`auditoria.accesos`, `.caja`,
 * `.inventario`, `.precios`), y el de la pestana es lo que decide si la
 * pestana existe. Con `auditoria.ver` sin los otros cuatro se ve una sola
 * pestana, y eso no es un error de permisos: es alguien a quien le pasaron
 * el acceso a la minima informacion.
 *
 * Lo que hace propia a esta pantalla es el renglon del `log`: trae el
 * registro de ANTES y el de DESPUES en crudo, y el backend no sabe que
 * tablas existen ni que campos tiene cada una. Por eso la pantalla arma el
 * cambio ella misma (`cambiosDeFila`): si el calculo viviera en el backend,
 * habria que tocarlo cada vez que se agregara una columna.
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
  /** El JSON de antes y el de despues, tal cual los guardo el trigger. */
  datos_anteriores: Record<string, unknown> | null;
  datos_nuevos: Record<string, unknown> | null;
}

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

export interface RenglonCaja {
  id: number;
  /** NULL cuando el renglon es de un DELETE: el movimiento ya no existe. */
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

/** El rango, igual para las cinco: dos dias opcionales. */
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

/** Un campo que se movio entre el renglon anterior y el nuevo. */
export interface Cambio {
  campo: string;
  antes: string;
  nuevo: string;
  /** El campo no existia antes, o no existe despues. */
  lado?: 'antes' | 'despues';
}

/**
 * Como se muestra un valor del JSON del trigger.
 *
 * El trigger guarda lo que hay en la fila y Postgres devuelve `NUMERIC` y
 * `DATE` como texto, y los booleanos como `true`/`false`. Aqui solo se
 * quiere una linea legible, no un type guard: un `"12.50"` y un `12.5` se
 * pintan igual y a quien lee la bitacora le sirve el numero, no el tipo de
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
 * Los campos que SE MOVIERON, en el orden en que estan en el registro nuevo.
 *
 * Es lo que hace util la bitacora: hundredas de columnas de las que solo
 * cambiaron dos. Solo van los que cambian, y se comparan ya pasadas por
 * `valorLegible` para que `null` contra `''` se vea como lo que es (un
 * campo que se vacio) y no como dos valores raros.
 *
 * Los campos que solo existen en un lado semarkan con `lado` para que la
 * tabla pueda distinguir "se lleno" de "cambio de valor": en un INSERT todo
 * es nuevo y esa es la unica lectura util.
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
 * alguien que no deberia esta intentando entrar. Van marcados en la columna
 * para que la lista se pueda recorrer sin leer cada renglon, que es como se
 * lee una bitacora: uno escanea, no lee linea por linea.
 */
export function eventoSospechoso(evento: EventoAcceso): boolean {
  return evento === 'login_fallido' || evento === 'acceso_denegado' || evento === 'bloqueo';
}

export const ETIQUETA_OPERACION: Record<Operacion, string> = {
  INSERT: 'Alta',
  UPDATE: 'Cambio',
  DELETE: 'Baja',
};

/**
 * La fecha de la bitacora: dia y hora.
 *
 * Se corta el ISO con `slice` y no con `new Date` a proposito: el navegador
 * lo correria a la zona horaria de quien la abre, y un renglon de las 00:15
 * se veria del dia anterior (o del siguiente) al otro lado del pais.
 */
export function fechaLegible(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/**
 * El rango por omision: el mes que va.
 *
 * Una bitacora sin rango son miles de renglones y la primera pregunta de
 * quien la abre es "que paso hoy", asi que el filtro arranca en el mes en
 * curso. Se puede limpiar con "Todo" para ir a buscar algo viejo, y las
 * fechas viajan como `AAAA-MM-DD` porque el repositorio las convierte a un
 * fin de dia EXCLUSIVO (`< fecha + 1`): es lo que hace que el dia final no
 * desaparezca del reporte.
 */
export function rangoDelMes(hoy = new Date()): Rango {
  const dia = hoyComoTexto(hoy);
  return { desde: `${dia.slice(0, 7)}-01`, hasta: dia };
}

/**
 * Si el rango tiene sentido, para no hacer un viaje que va a rebotar.
 *
 * El backend ya lo revisa (`rangoCoherente` en `auditoria/esquemas.ts`) y
 * devuelve 422. Preguntar aqui es solo para que el boton se apague con el
 * motivo a la vista, y se compara como texto: con `AAAA-MM-DD` el orden
 * lexicografico es el del calendario, y `new Date` correria a la zona
 * horaria del navegador.
 */
export function rangoIncoherente(desde?: string, hasta?: string): boolean {
  if (desde === undefined || hasta === undefined) return false;
  return desde > hasta;
}

@Injectable({ providedIn: 'root' })
export class AuditoriaApi {
  private readonly http = inject(HttpClient);

  /**
   * Las cinco llamadas son un `GET` con filtros y paginacion, y solo cambian
   * la ruta y los filtros propios de cada una. Se arma el `params` a mano en
   * cada metodo (y no con un objeto plano) porque varias bitacoras NO
   * aceptan busqueda: mandarle `buscar` a la de caja es un 400 del `strict`,
   * no un filtro que se ignore.
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

  /** Quien entro, con quien fallo y a quien se le nego el paso. */
  async accesos(
    opciones: Filtros & { evento?: EventoAcceso | null },
  ): Promise<Listado<RenglonAcceso>> {
    const params = this.comunes(opciones);
    if (opciones.evento) params['evento'] = opciones.evento;
    return this.listar<RenglonAcceso>('accesos', params);
  }

  /** Los movimientos de caja y bancos, con el saldo antes y despues. */
  async caja(
    opciones: Filtros & { tipo?: 'ingreso' | 'egreso' | null },
  ): Promise<Listado<RenglonCaja>> {
    const params = this.comunes(opciones, false);
    if (opciones.tipo) params['tipo'] = opciones.tipo;
    return this.listar<RenglonCaja>('caja', params);
  }

  /** Los movimientos de almacen, con la existencia antes y despues. */
  async inventario(opciones: Filtros): Promise<Listado<RenglonInventario>> {
    return this.listar<RenglonInventario>('inventario', this.comunes(opciones, false));
  }

  /** Los cambios de precio, con la variacion en moneda. */
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
   * `conBusqueda` esta en OFF para caja, inventario y precios porque sus
   * esquemas no la aceptan (`buscar` solo existe en el log y en accesos) y
   * mandarla seria un 400. Los ids de filtro (`cuenta_id`, `producto_id`,
   * `almacen_id`, `usuario_id`) no se exponen todavia: llegan vacios y la
   * pantalla filtra por nombre y por fecha, que es como se pregunta
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
