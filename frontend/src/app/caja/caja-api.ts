import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';
import { decimalComoTexto, redondearMonto } from '../nucleo/cifras';

/**
 * El servicio de caja y bancos.
 *
 * Es el módulo con la ÚNICA pantalla que borra, y el borrado es a propósito:
 * un movimiento de caja no tiene nombre ni aparece en documentos viejos, solo
 * vive en `auditoria_caja`. En los demás módulos el registro tiene nombre y se
 * conserva; aquí se borra y la regla automática del sistema
 * `fn_recalcular_saldo_cuenta` rehace el saldo de la cuenta. Ver la nota de
 * `caja/rutas.ts`.
 *
 * Tres cosas del comportamiento que la pantalla tiene que respetar:
 *
 *   1. **`saldo_actual` no se manda nunca.** Ni al dar de alta una cuenta ni
 *      al registrar el movimiento: lo recalcula el sistema sumando los
 *      movimientos. Aceptarlo dejaría cuadrar a mano lo que el sistema rehace
 *      al siguiente movimiento.
 *   2. **El resumen es aparte del listado.** La consulta de `/resumen` existe
 *      porque el listado viene paginado: un total de la página no es el total
 *      del periodo, y "hoy entra X" tiene que ser un número correcto.
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
  /** Lo recalcula la regla automática `fn_recalcular_saldo_cuenta`; la pantalla solo lo muestra. */
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
 * `saldo_periodo` NO es el saldo de la cuenta: es lo que entró menos lo que
 * salió DENTRO del rango. Son dos preguntas distintas, y el sistema las trae
 * separadas a propósito.
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

/**
 * `caja/modelo.ts` -> `CierreCuenta`, el arqueo de una cuenta en un día.
 *
 * `fondo` es lo que traía la cuenta antes del día y `esperado` el fondo más lo
 * del día: lo que debería haber al cerrar. `saldo_actual` es el saldo del
 * sistema AHORA y solo coincide con el esperado si el día es hoy y no hay
 * movimientos con fecha futura.
 */
export interface CierreCuenta {
  cuenta_id: number;
  cuenta: string;
  tipo: TipoCuenta;
  fondo: number;
  ingresos: number;
  egresos: number;
  esperado: number;
  saldo_actual: number;
  movimientos: number;
}

/** `caja/modelo.ts` -> `CierreDeCaja`. El `generado_en` es el "hasta ahora". */
export interface CierreDeCaja {
  fecha: string;
  generado_en: string;
  cuentas: CierreCuenta[];
}

/**
 * `caja/modelo.ts` -> `CorteCuenta`, lo que entró y salió de una cuenta dentro
 * del rango del corte.
 *
 * Sin fondo ni esperado, a diferencia del cierre: el corte no arquea la cuenta,
 * solo mira la ventana de horas.
 */
export interface CorteCuenta {
  cuenta_id: number;
  cuenta: string;
  tipo: TipoCuenta;
  ingresos: number;
  egresos: number;
  movimientos: number;
}

/**
 * `caja/modelo.ts` -> `CorteDeCaja`.
 *
 * `desde` y `hasta` son el rango ya resuelto por el sistema (con sus valores
 * por defecto) y `generado_en` la marca de cuando se pidió.
 */
export interface CorteDeCaja {
  desde: string;
  hasta: string;
  generado_en: string;
  cuentas: CorteCuenta[];
}

export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** `caja/modelo.ts` -> `Cuenta[]` de las categorías en uso. */
export interface CategoriaEnUso {
  categoria: string;
  movimientos: number;
}

/** Los datos que se mandan al crear un movimiento de caja. */
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

/** Los datos que se mandan al crear una cuenta. */
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
 * Arma los datos del movimiento.
 *
 *   - `cliente_id` y `proveedor_id` viajan los dos o ninguno: las reglas de
 *     validación rechazan un movimiento que sea de los dos, y la pantalla los
 *     deja excluyentes (elegir uno borra el otro) para no tener que explicar
 *     eso. Los dos en `null` es el caso legítimo: la renta del local no es de
 *     nadie.
 *   - `monto` va como texto normalizado, porque las reglas de validación lo
 *     revisan con `decimal(10, 2)` y "1,000" o " 500 " serían un 400.
 *   - La fecha vacía se omite y la pone el sistema (la de hoy, según el
 *     sistema y no según el huso del navegador).
 *   - `saldo_actual` no aparece: lo recalcula la regla automática del sistema.
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
    // Ya normalizado: `decimalComoTexto` también cambiaría la coma decimal por
    // punto, pero si se le pasa "1,500.50" se comería la coma equivocada.
    monto: decimalComoTexto(montoNormalizado(editor.monto), 2),
    cliente_id: cliente?.id ?? null,
    proveedor_id: proveedor?.id ?? null,
    descripcion: descripcionLimpia === '' ? null : descripcionLimpia,
    tiene_factura: tieneFactura,
  };
}

/** Los datos al dar de alta una cuenta. El `banco` es obligatorio si el tipo es banco. */
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
 * El monto tal como lo entienden las reglas de validación: punto decimal y sin
 * comas de miles.
 *
 * Hay dos formas de escribirlo y las dos se aceptan, porque las dos se
 * teclean:
 *
 *   - `1,500.50`, con coma de miles. Es como lo MUESTRA la pantalla, que usa
 *     `numeroComoTexto` con la coma de miles.
 *   - `1500,50`, con coma decimal. Es como se teclea un número con decimales
 *     en México.
 *
 * Se distinguen por lo que sigue a la coma: si son tres dígitos es un millar y
 * la coma se quita; si no, es el separador decimal y se cambia por punto. Un
 * `replace(',', '.')` a secas no sirve: convierte "1,500.50" en "1.500.50", que
 * ya no es un número, y el error que sale ("no es un número") no dice nada del
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
 * Se controla aquí para que quien no se equivocó no se entere por el sistema.
 * El `0` se rechaza porque las reglas de validación lo rechazan y porque la
 * tabla tiene `CHECK (monto > 0)`: un movimiento de cero no existe, y la regla
 * automática del sistema lo recalcularía como si nada.
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
 * La categoría: `texto('La categoria', 80, 2)`.
 *
 * Se acotan los dos lados porque el sistema acota los dos, y el máximo es el
 * que se olvida: "Renta del local de la calle Norte 1234, worries" pasa los
 * dos caracteres del mínimo y vuelve con un 422 de "es de 80 caracteres".
 */
export function problemaDeCategoria(categoria: string): string | null {
  const limpia = categoria.trim();
  if (limpia.length < 2) return 'La categoría es obligatoria.';
  if (limpia.length > 80) return 'La categoría es de 80 caracteres.';
  return null;
}

/**
 * El nombre de la cuenta: `texto('El nombre', 120)`, SIN mínimo.
 *
 * El sistema sí acepta un nombre vacío (la tabla solo pide `NOT NULL` y
 * `UNIQUE`), así que este límite de dos es de la pantalla y no un espejo de
 * las reglas de validación: una cuenta sin nombre es indistinguible de otra en
 * la lista, que es justo donde se mira cuando hay que encontrar un pago.
 */
export function problemaDeNombreCuenta(nombre: string): string | null {
  const limpio = nombre.trim();
  if (limpio.length < 2) return 'El nombre es obligatorio.';
  if (limpio.length > 120) return 'El nombre es de 120 caracteres.';
  return null;
}

/**
 * La descripción: `texto('La descripcion', 300)`, sin mínimo.
 *
 * Sin saltos de línea. `texto` rechaza cualquier carácter de control
 * (`tieneControl`), así que la descripción es un `input` de una línea y NO un
 * `textarea`: un "pulse enter por error" sería un 422 con un mensaje que no
 * dice nada de los saltos de línea. El `replace` de abajo es la red por si el
 * campo recibe uno pegado de otro lado.
 */
export function problemaDeDescripcion(descripcion: string): string | null {
  const limpia = unaLinea(descripcion);
  return limpia.length > 300 ? 'La descripción es de 300 caracteres.' : null;
}

/** Quita los saltos de línea, para lo que las reglas de validación no aceptan. */
export function unaLinea(texto: string): string {
  return texto.replace(/[\r\n\t]+/g, ' ').trim();
}

/** Un saldo negativo: lo que la tabla pinta en rojo. */
export function saldoNegativo(saldo: number): boolean {
  return saldo < 0;
}

/**
 * Los totales del periodo, para la línea de arriba.
 *
 * Se suman los `saldo_periodo` de cada cuenta y no `saldo_actual`: el resumen
 * es de lo que pasó en el rango, y mezclar las dos sumas es como se cuadra mal
 * un día.
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

/**
 * Los totales del cierre, para la línea de arriba.
 *
 * Se suma el `esperado` de cada cuenta y no el `saldo_actual`: el cierre es de
 * lo que debería haber al terminar el día, y el saldo actual arrastra los
 * movimientos con fecha futura. Se suman los cuatro y no se recalcula el
 * esperado a partir de los otros tres, porque el del sistema es el que vale.
 */
export function totalesDeCierre(cuentas: CierreCuenta[]): {
  fondo: number;
  ingresos: number;
  egresos: number;
  esperado: number;
} {
  return cuentas.reduce(
    (acumulado, cuenta) => ({
      fondo: redondearMonto(acumulado.fondo + cuenta.fondo),
      ingresos: redondearMonto(acumulado.ingresos + cuenta.ingresos),
      egresos: redondearMonto(acumulado.egresos + cuenta.egresos),
      esperado: redondearMonto(acumulado.esperado + cuenta.esperado),
    }),
    { fondo: 0, ingresos: 0, egresos: 0, esperado: 0 },
  );
}

/**
 * Los totales del corte, para la línea de arriba.
 *
 * Solo lo que entró y lo que salió: el corte no arquea la cuenta, así que no
 * hay fondo ni esperado que sumar. Es la misma suma del resumen pero sobre la
 * ventana de horas, que es lo único que cambia.
 */
export function totalesDeCorte(cuentas: CorteCuenta[]): {
  ingresos: number;
  egresos: number;
} {
  return cuentas.reduce(
    (acumulado, cuenta) => ({
      ingresos: redondearMonto(acumulado.ingresos + cuenta.ingresos),
      egresos: redondearMonto(acumulado.egresos + cuenta.egresos),
    }),
    { ingresos: 0, egresos: 0 },
  );
}

// ---------------------------------------------------------------- las llamadas

@Injectable({ providedIn: 'root' })
export class CajaApi {
  private readonly http = inject(HttpClient);

  /** Las cuentas. Sin paginación y sin envoltura: son pocas. */
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

  /** Las categorías en uso, para el desplegable del editor. */
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
    // Las reglas de validación lo leen como el texto 'true'/'false', no como booleano.
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
   * Borra el movimiento. La única baja de todo el proyecto.
   *
   * Responde 204 sin cuerpo: lo que interesa después es el saldo de la cuenta,
   * y ese lo recalcula la regla automática del sistema. Por eso quien llama
   * vuelve a pedir las cuentas en vez de intentar restar el monto a mano.
   */
  async eliminarMovimiento(id: number): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${API}/caja/movimientos/${id}`));
  }

  /**
   * El periodo por cuenta.
   *
   * Aparte del listado y sin paginar, porque las sumas de una página no son
   * las sumas del periodo. Sin fechas es toda la historia.
   */
  async resumen(desde?: string, hasta?: string): Promise<ResumenCuenta[]> {
    const params: Record<string, string> = {};
    if (desde) params['desde'] = desde;
    if (hasta) params['hasta'] = hasta;
    return firstValueFrom(this.http.get<ResumenCuenta[]>(`${API}/caja/resumen`, { params }));
  }

  /**
   * El cierre de caja de un día.
   *
   * Sin fecha el sistema usa el día de HOY según el sistema, no el del
   * navegador: es la misma regla que el alta de un movimiento. Es de solo
   * lectura, así que no hay datos ni estado que mandar.
   */
  async cierre(fecha?: string): Promise<CierreDeCaja> {
    const params: Record<string, string> = {};
    if (fecha) params['fecha'] = fecha;
    return firstValueFrom(this.http.get<CierreDeCaja>(`${API}/caja/cierre`, { params }));
  }

  /**
   * El corte de caja de un rango de día y hora.
   *
   * Los dos momentos son opcionales: sin `desde` el sistema arranca en la
   * medianoche de hoy y sin `hasta` termina ahora, los dos según el reloj del
   * sistema. La pantalla manda los valores tal como salen del `datetime-local`
   * (`AAAA-MM-DDTHH:MM`), que es el formato que las reglas de validación
   * aceptan.
   */
  async corte(desde?: string, hasta?: string): Promise<CorteDeCaja> {
    const params: Record<string, string> = {};
    if (desde) params['desde'] = desde;
    if (hasta) params['hasta'] = hasta;
    return firstValueFrom(this.http.get<CorteDeCaja>(`${API}/caja/corte`, { params }));
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
