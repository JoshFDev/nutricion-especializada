import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { decimalComoTexto, redondearMonto } from '../nucleo/cifras';

/**
 * La API de caja y bancos.
 *
 * Es el modulo con la UNICA pantalla que borra, y el borrado es de a
 * proposito: un movimiento de caja no tiene nombre ni aparece en documentos
 * viejos, solo vive en `auditoria_caja`. En los demas modulos el registro tiene
 * nombre y se conserva; aqui se borra y el trigger `fn_recalcular_saldo_cuenta`
 * rehace el saldo de la cuenta. Ver la nota de `caja/rutas.ts`.
 *
 * Tres cosas del contrato que la pantalla tiene que respetar:
 *
 *   1. **`saldo_actual` no se manda nunca.** Ni en el alta de cuenta ni en el
 *      movimiento: lo recalcula la base sumando los movimientos. Aceptarlo
 *      dejaria cuadrar a mano lo que el servidor rehace al siguiente movimiento.
 *   2. **El resumen es aparte del listado.** `GET /resumen` existe porque el
 *      listado viene paginado: un total de la pagina no es el total del
 *      periodo, y "hoy entra X" tiene que ser un numero correcto.
 *   3. **`/cuentas` y `/categorias` no son listados paginados.** Devuelven
 *      arreglos sueltos (`Cuenta[]`), no la envoltura con `total`: son pocas
 *      y se usan todas.
 */

export const TIPOS_CUENTA = ['efectivo', 'banco'] as const;
export type TipoCuenta = (typeof TIPOS_CUENTA)[number];

export const TIPOS_MOVIMIENTO = ['ingreso', 'egreso'] as const;
export type TipoMovimiento = (typeof TIPOS_MOVIMIENTO)[number];

/** `caja/modelo.ts` -> `Cuenta`. */
export interface Cuenta {
  id: number;
  nombre: string;
  tipo: TipoCuenta;
  banco: string | null;
  titular: string | null;
  /** Lo recalcula `fn_recalcular_saldo_cuenta`; la pantalla solo lo muestra. */
  saldo_actual: number;
}

/** `caja/modelo.ts` -> `MovimientoListado`, lo que muestra la tabla. */
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

/** `caja/modelo.ts` -> `Movimiento`, el detalle. */
export interface Movimiento extends MovimientoListado {
  cliente_id: number | null;
  proveedor_id: number | null;
  descripcion: string | null;
  creado_en: string;
}

/**
 * `caja/modelo.ts` -> `ResumenCuenta`.
 *
 * `saldo_periodo` NO es el saldo de la cuenta: es lo que entro menos lo que
 * salio DENTRO del rango. Son dos preguntas distintas, y la base las trae
 * separadas a proposito.
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

/** `caja/modelo.ts` -> `Cuenta[]` de las categorias en uso. */
export interface CategoriaEnUso {
  categoria: string;
  movimientos: number;
}

/** El cuerpo de `POST /api/caja/movimientos`. */
export interface CuerpoMovimiento {
  cuenta_id: number;
  fecha?: string;
  tipo: TipoMovimiento;
  categoria: string;
  monto: string;
  cliente_id: number | null;
  proveedor_id: number | null;
  descripcion: string | null;
  tiene_factura: boolean;
}

/** El cuerpo de `POST /api/caja/cuentas`. */
export interface CuerpoCuenta {
  nombre: string;
  tipo: TipoCuenta;
  banco: string | null;
  titular: string | null;
}

/** Lo que la pantalla necesita para decidir si se puede guardar. */
export interface EditorMovimiento {
  cuenta_id: number | null;
  tipo: TipoMovimiento;
  categoria: string;
  monto: string;
}

/** Un cliente o proveedor ya elegido. El nombre se guarda para mostrarlo. */
export interface OpcionNombrada {
  id: number;
  nombre: string;
}

// ------------------------------------------------------------------ el cuerpo

/**
 * Arma el cuerpo del movimiento.
 *
 *   - `cliente_id` y `proveedor_id` viajan los dos o ninguno: el esquema
 *     rechaza un movimiento que sea de los dos, y la pantalla los deja
 *     excluyentes (elegir uno borra el otro) para no tener que explicar eso.
 *     Los dos en `null` es el caso legitimo: la renta del local no es de
 *     nadie.
 *   - `monto` va como texto normalizado, porque el esquema lo valida con
 *     `decimal(10, 2)` y "1,000" o " 500 " serian un 400.
 *   - La fecha vacia se omite y la pone el backend (la de hoy, segun la base
 *     y no segun el huso del navegador).
 *   - `saldo_actual` no aparece: lo recalcula el trigger.
 */
export function cuerpoDeMovimiento(
  editor: EditorMovimiento,
  cliente: OpcionNombrada | null,
  proveedor: OpcionNombrada | null,
  fecha: string,
  descripcion: string,
  tieneFactura: boolean,
): CuerpoMovimiento {
  if (editor.cuenta_id === null) {
    throw new Error('un movimiento necesita una cuenta');
  }
  const problema = problemaDeMonto(editor.monto);
  if (problema !== null) throw new Error(problema);
  const descripcionLimpia = unaLinea(descripcion);

  return {
    cuenta_id: editor.cuenta_id,
    fecha: fecha === '' ? undefined : fecha,
    tipo: editor.tipo,
    categoria: unaLinea(editor.categoria),
    // Ya normalizado: `decimalComoTexto` tambien cambiaria la coma decimal por
    // punto, pero si se le pasa "1,500.50" se comeria la coma equivocada.
    monto: decimalComoTexto(montoNormalizado(editor.monto), 2),
    cliente_id: cliente?.id ?? null,
    proveedor_id: proveedor?.id ?? null,
    descripcion: descripcionLimpia === '' ? null : descripcionLimpia,
    tiene_factura: tieneFactura,
  };
}

/** El cuerpo del alta de cuenta. El `banco` es obligatorio si el tipo es banco. */
export function cuerpoDeCuenta(
  nombre: string,
  tipo: TipoCuenta,
  banco: string,
  titular: string,
): CuerpoCuenta {
  const bancoLimpio = unaLinea(banco);
  const titularLimpio = unaLinea(titular);
  if (tipo === 'banco' && bancoLimpio === '') {
    throw new Error('una cuenta de banco necesita el nombre del banco');
  }
  return {
    nombre: unaLinea(nombre),
    tipo,
    banco: bancoLimpio === '' ? null : bancoLimpio,
    titular: titularLimpio === '' ? null : titularLimpio,
  };
}

/**
 * El monto tal como lo entiende el esquema: punto decimal y sin comas de miles.
 *
 * Hay dos formas de escribirlo y las dos se aceptan, porque las dos se teclean:
 *
 *   - `1,500.50`, con coma de miles. Es como lo MUESTRA la pantalla, que usa
 *     `numeroComoTexto` con la coma de miles.
 *   - `1500,50`, con coma decimal. Es como se teclea un numero con decimales en
 *     Mexico.
 *
 * Se distinguen por lo que sigue a la coma: si son tres digitos es un millar y
 * la coma se quita; si no, es el separador decimal y se cambia por punto. Un
 * `replace(',', '.')` a secas no sirve: convierte "1,500.50" en "1.500.50", que
 * ya no es un numero, y el error que sale ("no es un numero") no dice nada del
 * formato.
 */
export function montoNormalizado(texto: string): string {
  const limpio = texto.trim();
  const sinMiles = limpio.replace(/(\d),(?=\d{3}(\D|$))/g, '$1');
  return sinMiles.replace(',', '.');
}

/**
 * El monto, como lo quiere `decimal(10, 2)`.
 *
 * Se controla aqui para que el que no se equivoco no se entere por el
 * servidor. El `0` se rechaza porque el esquema lo rechaza y porque la tabla
 * tiene `CHECK (monto > 0)`: un movimiento de cero no existe, y un trigger lo
 * recalcularia como si nada.
 */
export function problemaDeMonto(monto: string): string | null {
  const limpio = montoNormalizado(monto);
  if (limpio === '') return 'El monto es obligatorio.';
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(limpio)) {
    return 'El monto es un número de hasta 10 enteros y 2 decimales.';
  }
  if (Number(limpio) <= 0) return 'El monto tiene que ser mayor que cero.';
  return null;
}

/**
 * La categoria: `texto('La categoria', 80, 2)`.
 *
 * Se acotan los dos lados porque el servidor acota los dos, y el maximo es el
 * que se olvida: "Renta del local de la calle Norte 1234, worries" pasa los
 * dos caracteres del minimo y vuelve con un 422 de "es de 80 caracteres".
 */
export function problemaDeCategoria(categoria: string): string | null {
  const limpia = categoria.trim();
  if (limpia.length < 2) return 'La categoría es obligatoria.';
  if (limpia.length > 80) return 'La categoría es de 80 caracteres.';
  return null;
}

/**
 * El nombre de la cuenta: `texto('El nombre', 120)`, SIN minimo.
 *
 * El servidor si acepta un nombre vacio (la tabla solo pide `NOT NULL` y
 * `UNIQUE`), asi que este limite de dos es de la pantalla y no un espejo del
 * esquema: una cuenta sin nombre es indistinguible de otra en la lista, que
 * es justo donde se mira cuando hay que encontrar un pago.
 */
export function problemaDeNombreCuenta(nombre: string): string | null {
  const limpio = nombre.trim();
  if (limpio.length < 2) return 'El nombre es obligatorio.';
  if (limpio.length > 120) return 'El nombre es de 120 caracteres.';
  return null;
}

/**
 * La descripcion: `texto('La descripcion', 300)`, sin minimo.
 *
 * Sin newline. `texto` rechaza cualquier caracter de control (`tieneControl`),
 * asi que la descripcion es un `input` de una linea y NO un `textarea`: un
 * "pulse enter por error" seria un 422 con un mensaje que no dice nada de los
 * saltos de linea. El `replace` de abajo es la red por si el campo recibe uno
 * pegado de otro lado.
 */
export function problemaDeDescripcion(descripcion: string): string | null {
  const limpia = unaLinea(descripcion);
  return limpia.length > 300 ? 'La descripción es de 300 caracteres.' : null;
}

/** Quita los saltos de linea, para lo que el esquema no acepta. */
export function unaLinea(texto: string): string {
  return texto.replace(/[\r\n\t]+/g, ' ').trim();
}

/** Un saldo negativo: lo que la tabla pinta en rojo. */
export function saldoNegativo(saldo: number): boolean {
  return saldo < 0;
}

/**
 * Los totales del periodo, para la linea de arriba.
 *
 * Se suman los `saldo_periodo` de cada cuenta y no `saldo_actual`: el
 * resumen es de lo que paso en el rango, y mezclar las dos sumas es como se
 * cuadra mal un dia.
 */
export function totalesDeResumen(resumen: ResumenCuenta[]): {
  ingresos: number;
  egresos: number;
  saldo: number;
} {
  return resumen.reduce(
    (acumulado, cuenta) => ({
      ingresos: redondearMonto(acumulado.ingresos + cuenta.ingresos),
      egresos: redondearMonto(acumulado.egresos + cuenta.egresos),
      saldo: redondearMonto(acumulado.saldo + cuenta.saldo_periodo),
    }),
    { ingresos: 0, egresos: 0, saldo: 0 },
  );
}

// ---------------------------------------------------------------- las llamadas

@Injectable({ providedIn: 'root' })
export class CajaApi {
  private readonly http = inject(HttpClient);

  /** Las cuentas. Sin paginacion y sin envoltura: son pocas. */
  async cuentas(tipo?: TipoCuenta): Promise<Cuenta[]> {
    return firstValueFrom(
      this.http.get<Cuenta[]>(`${API}/caja/cuentas`, {
        params: tipo ? { tipo } : {},
      }),
    );
  }

  /** Alta de cuenta. Devuelve 201 con la cuenta ya con su saldo en cero. */
  async crearCuenta(cuerpo: CuerpoCuenta): Promise<Cuenta> {
    return firstValueFrom(this.http.post<Cuenta>(`${API}/caja/cuentas`, cuerpo));
  }

  /** Las categorias en uso, para el desplegable del editor. */
  async categorias(cuentaId?: number): Promise<CategoriaEnUso[]> {
    return firstValueFrom(
      this.http.get<CategoriaEnUso[]>(`${API}/caja/categorias`, {
        params: cuentaId === undefined ? {} : { cuenta_id: cuentaId },
      }),
    );
  }

  /** El listado de movimientos, con los filtros de la pantalla. */
  async movimientos(opciones: {
    buscar?: string;
    cuenta_id?: number;
    tipo?: TipoMovimiento;
    categoria?: string;
    con_factura?: boolean;
    desde?: string;
    hasta?: string;
    limite?: number;
    offset?: number;
  }): Promise<Listado<MovimientoListado>> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
    };
    if (opciones.buscar) params['buscar'] = opciones.buscar;
    if (opciones.cuenta_id !== undefined) params['cuenta_id'] = opciones.cuenta_id;
    if (opciones.tipo) params['tipo'] = opciones.tipo;
    if (opciones.categoria) params['categoria'] = opciones.categoria;
    // El esquema lo lee como el texto 'true'/'false', no como booleano.
    if (opciones.con_factura !== undefined) {
      params['con_factura'] = opciones.con_factura ? 'true' : 'false';
    }
    if (opciones.desde) params['desde'] = opciones.desde;
    if (opciones.hasta) params['hasta'] = opciones.hasta;
    return firstValueFrom(
      this.http.get<Listado<MovimientoListado>>(`${API}/caja/movimientos`, { params }),
    );
  }

  /** El detalle de un movimiento. */
  async obtenerMovimiento(id: number): Promise<Movimiento> {
    return firstValueFrom(this.http.get<Movimiento>(`${API}/caja/movimientos/${id}`));
  }

  async crearMovimiento(cuerpo: CuerpoMovimiento): Promise<Movimiento> {
    return firstValueFrom(this.http.post<Movimiento>(`${API}/caja/movimientos`, cuerpo));
  }

  /**
   * Borra el movimiento. El unico DELETE de todo el proyecto.
   *
   * Responde 204 sin cuerpo: lo que interesa despues es el saldo de la cuenta,
   * y ese lo recalcula el trigger. Por eso quien llama vuelve a pedir las
   * cuentas en vez de intentar restar el monto a mano.
   */
  async eliminarMovimiento(id: number): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${API}/caja/movimientos/${id}`));
  }

  /**
   * El periodo por cuenta.
   *
   * Aparte del listado y sin paginar, porque las sumas de una pagina no son
   * las sumas del periodo. Sin fechas es toda la historia.
   */
  async resumen(desde?: string, hasta?: string): Promise<ResumenCuenta[]> {
    const params: Record<string, string> = {};
    if (desde) params['desde'] = desde;
    if (hasta) params['hasta'] = hasta;
    return firstValueFrom(this.http.get<ResumenCuenta[]>(`${API}/caja/resumen`, { params }));
  }

  /** Clientes para el buscador del editor. */
  async clientes(buscar: string): Promise<{ id: number; nombre: string }[]> {
    if (buscar.trim().length < 2) return [];
    const respuesta = await firstValueFrom(
      this.http.get<Listado<{ id: number; nombre: string }>>(`${API}/clientes`, {
        params: { buscar: buscar.trim(), limite: 20 },
      }),
    );
    return respuesta.datos;
  }

  /** Proveedores para el buscador del editor. */
  async proveedores(buscar: string): Promise<{ id: number; nombre: string }[]> {
    if (buscar.trim().length < 2) return [];
    const respuesta = await firstValueFrom(
      this.http.get<Listado<{ id: number; nombre: string }>>(`${API}/proveedores`, {
        params: { buscar: buscar.trim(), limite: 20, activo: true },
      }),
    );
    return respuesta.datos;
  }
}
