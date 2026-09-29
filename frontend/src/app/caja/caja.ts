import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { crearBuscador } from '../nucleo/buscador';
import { Sesion } from '../nucleo/sesion';
import { montoComoTexto } from '../nucleo/cifras';
import {
  CajaApi,
  cuerpoDeCuenta,
  cuerpoDeMovimiento,
  problemaDeCategoria,
  problemaDeDescripcion,
  problemaDeMonto,
  problemaDeNombreCuenta,
  saldoNegativo,
  totalesDeResumen,
  type CategoriaEnUso,
  type Cuenta,
  type Movimiento,
  type MovimientoListado,
  type OpcionNombrada,
  type ResumenCuenta,
  type TipoCuenta,
  type TipoMovimiento,
} from './caja-api';

/**
 * La pantalla de caja y bancos.
 *
 * CUATRO vistas en un solo componente:
 *
 *   - **lista**: el periodo por cuenta arriba y los movimientos con sus
 *     filtros abajo.
 *   - **cuentas**: las cuentas con su saldo, y el alta de una nueva.
 *   - **captura**: un ingreso o un egreso.
 *   - **detalle**: el movimiento guardado, y desde ahi se borra.
 *
 * Lo que hace distinta a las demas pantallas, y por que:
 *
 *   - **Es el unico modulo con DELETE.** En los otros, el registro tiene
 *     nombre y aparece en documentos viejos, asi que se conserva y se cancela.
 *     Un movimiento de caja solo vive en `auditoria_caja`, y el permiso que lo
 *     autoriza (`caja.eliminar`) se creo desde el principio para eso. Por eso
 *     el borrado pide confirmacion escribiendo el monto, no un `confirm` de
 *     una linea.
 *   - **El saldo no se toca nunca desde la pantalla.** Lo recalcula
 *     `fn_recalcular_saldo_cuenta` sumando los movimientos de la cuenta. Por
 *     eso despues de guardar o de borrar se vuelven a pedir las cuentas y el
 *     resumen: el numero que se muestra no es el que se calculo aqui.
 *   - **Cliente y proveedor son excluyentes.** El esquema rechaza un
 *     movimiento que sea de los dos, y los dos vacios es legitimo (la renta
 *     del local no es de nadie). Elegir uno borra al otro en vez de dejar que
 *     el servidor lo rechace.
 *   - **La descripcion es un `input` de una linea, no un `textarea`.** El
 *     esquema usa `texto()`, que rechaza los caracteres de control, y un
 *     "enter" de mas seria un 422 que no menciona los saltos de linea.
 *
 * El resumen comparte las fechas con el listado y no con los demas filtros: un
 * periodo es una sola cosa en la pantalla, mientras que "solo egresos" o
 * "solo la cuenta del banco" son filtros de la tabla de abajo. Se dice en la
 * tarjeta, porque un resumen que no corresponde a lo que se esta viendo es
 * como se cuadra mal un dia.
 */
type Pantalla = 'lista' | 'cuentas' | 'captura' | 'detalle';

@Component({
  selector: 'app-caja',
  templateUrl: './caja.html',
  styleUrl: './caja.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Caja {
  private readonly api = inject(CajaApi);
  private readonly sesion = inject(Sesion);

  readonly pantalla = signal<Pantalla>('lista');

  /**
   * El alta de cuenta pide `caja.capturar` y no un permiso propio: la tabla
   * de permisos no tiene `caja.editar`, y crear uno solo para el admin dejaria
   * a la cajera sin poder abrir la cuenta del banco nuevo. Ver la nota de
   * `caja/rutas.ts`.
   */
  readonly puedeCrear = computed(() => this.sesion.puede('caja.capturar'));
  readonly puedeEliminar = computed(() => this.sesion.puede('caja.eliminar'));

  // ------------------------------------------------------------- las cuentas
  // Se piden siempre, tambien en la lista: el resumen los trae con nombre y
  // saldo, pero el formulario de la captura necesita el id de la cuenta.
  readonly cuentas = signal<Cuenta[]>([]);
  readonly errorCuentas = signal<string | null>(null);

  async cargarCuentas(): Promise<void> {
    this.errorCuentas.set(null);
    try {
      this.cuentas.set(await this.api.cuentas());
    } catch (falla) {
      this.errorCuentas.set(errorLegible(falla).mensaje);
    }
  }

  // ---------------------------------------------------------------- el resumen
  /** Una fila por cuenta, con lo que entro y salio DENTRO del periodo. */
  readonly resumenCuentas = signal<ResumenCuenta[]>([]);
  readonly cargandoResumen = signal(false);
  readonly errorResumen = signal<string | null>(null);

  /** Los tres numeros de arriba: lo que entro, lo que salio y la diferencia. */
  readonly totales = computed(() => totalesDeResumen(this.resumenCuentas()));

  async cargarResumen(): Promise<void> {
    this.cargandoResumen.set(true);
    this.errorResumen.set(null);
    try {
      this.resumenCuentas.set(
        await this.api.resumen(this.filtroDesde() || undefined, this.filtroHasta() || undefined),
      );
    } catch (falla) {
      this.resumenCuentas.set([]);
      this.errorResumen.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoResumen.set(false);
    }
  }

  // --------------------------------------------------------------- el listado
  readonly filas = signal<MovimientoListado[]>([]);
  readonly totalEncontrado = signal(0);
  readonly cargando = signal(false);
  readonly cargandoMas = signal(false);
  readonly errorLista = signal<string | null>(null);
  /** El aviso de "se borro" y de "se abrio la cuenta". */
  readonly exito = signal<string | null>(null);

  readonly filtroTexto = signal('');
  readonly filtroCuenta = signal('');
  readonly filtroTipo = signal<'' | TipoMovimiento>('');
  readonly filtroCategoria = signal('');
  readonly filtroFactura = signal<'' | 'si' | 'no'>('');
  readonly filtroDesde = signal('');
  readonly filtroHasta = signal('');

  readonly hayMas = computed(() => this.filas().length < this.totalEncontrado());

  // --------------------------------------------------------------- la captura
  readonly editor = signal({
    cuenta_id: null as number | null,
    tipo: 'egreso' as TipoMovimiento,
    categoria: '',
    monto: '',
  });
  /**
   * El cliente y el proveedor elegidos, con su nombre.
   *
   * Se guardan como opcion y no solo como id porque el campo tiene que poder
   * mostrar el nombre elegido sin volver a preguntarlo, y porque los dos son
   * excluyentes: en cuanto se elige uno, el otro se limpia.
   */
  readonly cliente = signal<OpcionNombrada | null>(null);
  readonly proveedor = signal<OpcionNombrada | null>(null);
  readonly fecha = signal('');
  readonly descripcion = signal('');
  readonly tieneFactura = signal(false);
  readonly categorias = signal<CategoriaEnUso[]>([]);
  readonly guardando = signal(false);
  readonly errorCaptura = signal<string | null>(null);

  readonly buscadorCliente = crearBuscador({
    cargar: (texto) => this.api.clientes(texto),
    minimo: 2,
    nada: (texto) => `Ningún cliente coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirCliente(opcion),
  });

  readonly buscadorProveedor = crearBuscador({
    cargar: (texto) => this.api.proveedores(texto),
    minimo: 2,
    nada: (texto) => `Ningún proveedor coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirProveedor(opcion),
  });

  /**
   * Lo que falta para poder guardar, en el orden en que aparece el formulario.
   *
   * El monto se valida con la misma regla del esquema (`decimal(10, 2)` y mayor
   * que cero) para que el 422 no llegue por escribir "0" o un numero con tres
   * decimales. La categoria igual, con su minimo de dos.
   */
  readonly problemas = computed(() => {
    const editor = this.editor();
    const fallas: (string | null)[] = [];
    if (editor.cuenta_id === null) fallas.push('Elige la cuenta.');
    fallas.push(problemaDeCategoria(editor.categoria));
    fallas.push(problemaDeMonto(editor.monto));
    fallas.push(problemaDeDescripcion(this.descripcion()));
    // `filter` sobre un arreglo de `string | null`: el tipo sale solo, sin
    // castear cada problema.
    return fallas.filter((falla): falla is string => falla !== null);
  });

  readonly puedeGuardar = computed(
    () => this.problemas().length === 0 && this.puedeCrear() && !this.guardando(),
  );

  // --------------------------------------------------------------- el detalle
  readonly detalle = signal<Movimiento | null>(null);
  readonly errorDetalle = signal<string | null>(null);
  readonly borrando = signal(false);
  /** El borrado se confirma escribiendo el monto, no con un `confirm`. */
  readonly confirmandoBorrado = signal(false);
  readonly montoParaBorrar = signal('');

  // ---------------------------------------------------------- las cuentas (alta)
  readonly nombreCuenta = signal('');
  readonly tipoCuenta = signal<TipoCuenta>('efectivo');
  readonly bancoCuenta = signal('');
  readonly titularCuenta = signal('');
  readonly guardandoCuenta = signal(false);
  readonly errorAltaCuenta = signal<string | null>(null);

  readonly problemaNombreCuenta = computed(() => problemaDeNombreCuenta(this.nombreCuenta()));
  /**
   * El banco solo se pide si el tipo es `banco`. El backend lo exige con un
   * `refine` y la base no: una cuenta de banco sin nombre de banco no se
   * distingue de otra en la lista, que es donde se mira.
   */
  readonly problemaBancoCuenta = computed(() =>
    this.tipoCuenta() === 'banco' && this.bancoCuenta().trim() === ''
      ? 'Una cuenta de banco necesita el nombre del banco.'
      : null,
  );

  readonly puedeGuardarCuenta = computed(
    () =>
      this.problemaNombreCuenta() === null &&
      this.problemaBancoCuenta() === null &&
      this.puedeCrear() &&
      !this.guardandoCuenta(),
  );

  constructor() {
    void this.cargar();
  }

  /** Todo lo de la lista, junto. El resumen y las cuentas van siempre. */
  private async cargar(): Promise<void> {
    await Promise.all([this.cargarCuentas(), this.cargarResumen(), this.recargar()]);
  }

  // --------------------------------------------------------------- el listado
  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /** Busca con 250 ms de espera, como el resto de las pantallas. */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.filtroTexto.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  /** El minimo de dos caracteres, como en proveedores y clientes. */
  private textoBusqueda(): string | undefined {
    const limpio = this.filtroTexto().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  cambiarCuenta(valor: string): void {
    this.filtroCuenta.set(valor);
    void this.recargar();
  }

  cambiarTipo(valor: string): void {
    this.filtroTipo.set(valor as '' | TipoMovimiento);
    void this.recargar();
  }

  cambiarCategoria(valor: string): void {
    this.filtroCategoria.set(valor);
    void this.recargar();
  }

  cambiarFactura(valor: string): void {
    this.filtroFactura.set(valor as '' | 'si' | 'no');
    void this.recargar();
  }

  cambiarDesde(valor: string): void {
    this.filtroDesde.set(valor);
    // El resumen comparte el periodo, asi que también se recarga.
    void Promise.all([this.recargar(), this.cargarResumen()]);
  }

  cambiarHasta(valor: string): void {
    this.filtroHasta.set(valor);
    void Promise.all([this.recargar(), this.cargarResumen()]);
  }

  /**
   * `con_factura` es el unico filtro que viaja como texto 'true'/'false'.
   *
   * El esquema lo declara como `z.enum(['true','false'])` y lo transforma a
   * booleano: mandar el booleano de JavaScript seria un 400, porque `true` no
   * es el texto "true". Por eso la api lo recibe como `boolean` y lo
   * convierte al mandar la peticion.
   */
  private facturaPedida(): boolean | undefined {
    const actual = this.filtroFactura();
    if (actual === 'si') return true;
    if (actual === 'no') return false;
    return undefined;
  }

  async recargar(): Promise<void> {
    this.cargando.set(true);
    this.errorLista.set(null);
    try {
      const resultado = await this.api.movimientos(this.filtros(0));
      this.filas.set(resultado.datos);
      this.totalEncontrado.set(resultado.total);
    } catch (falla) {
      this.filas.set([]);
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
    }
  }

  async cargarMas(): Promise<void> {
    if (!this.hayMas() || this.cargandoMas()) return;
    this.cargandoMas.set(true);
    try {
      const resultado = await this.api.movimientos(this.filtros(this.filas().length));
      this.filas.update((ya) => [...ya, ...resultado.datos]);
      this.totalEncontrado.set(resultado.total);
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoMas.set(false);
    }
  }

  private filtros(offset: number): Parameters<CajaApi['movimientos']>[0] {
    return {
      buscar: this.textoBusqueda(),
      cuenta_id: this.filtroCuenta() === '' ? undefined : Number(this.filtroCuenta()),
      tipo: this.filtroTipo() || undefined,
      categoria: this.filtroCategoria().trim() || undefined,
      con_factura: this.facturaPedida(),
      desde: this.filtroDesde() || undefined,
      hasta: this.filtroHasta() || undefined,
      offset,
    };
  }

  /** Quita todos los filtros de la tabla, no las fechas: esas son el periodo. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.filtroTexto.set('');
    this.filtroCuenta.set('');
    this.filtroTipo.set('');
    this.filtroCategoria.set('');
    this.filtroFactura.set('');
    void this.recargar();
  }

  // --------------------------------------------------------------- la captura
  /** Abre el alta en blanco. El egreso es el primero: es lo que mas se captura. */
  nueva(): void {
    this.editor.set({
      cuenta_id: this.cuentas()[0]?.id ?? null,
      tipo: 'egreso',
      categoria: '',
      monto: '',
    });
    this.cliente.set(null);
    this.proveedor.set(null);
    this.fecha.set('');
    this.descripcion.set('');
    this.tieneFactura.set(false);
    this.errorCaptura.set(null);
    this.buscadorCliente.limpiar();
    this.buscadorProveedor.limpiar();
    void this.cargarCategorias();
    this.pantalla.set('captura');
  }

  /** Las categorias que ya se usan, para el `datalist` del campo. */
  private async cargarCategorias(): Promise<void> {
    const cuenta = this.editor().cuenta_id;
    try {
      this.categorias.set(await this.api.categorias(cuenta === null ? undefined : cuenta));
    } catch {
      // Las categorias son una ayuda, no un dato: si fallan, el campo se sigue
      // escribiendo a mano y no se avisa de nada.
      this.categorias.set([]);
    }
  }

  cambiarCuentaEditada(valor: string): void {
    const id = valor === '' ? null : Number(valor);
    this.editor.update((editor) => ({ ...editor, cuenta_id: id }));
    void this.cargarCategorias();
  }

  cambiarTipoEditado(valor: string): void {
    this.editor.update((editor) => ({ ...editor, tipo: valor as TipoMovimiento }));
  }

  ponerCategoria(valor: string): void {
    this.editor.update((editor) => ({ ...editor, categoria: valor }));
  }

  ponerMonto(valor: string): void {
    this.editor.update((editor) => ({ ...editor, monto: valor }));
  }

  /**
   * Elegir un cliente borra al proveedor, y al reves.
   *
   * El esquema rechaza un movimiento que tenga los dos, y dejarlos se
   * llenando para que el servidor avise al final es peor que decidir aqui que
   * un movimiento es de UNO. Los dos vacios si es legitimo: la renta del local
   * no es de nadie.
   */
  elegirCliente(opcion: OpcionNombrada): void {
    this.cliente.set(opcion);
    this.proveedor.set(null);
    this.buscadorProveedor.limpiar();
  }

  elegirProveedor(opcion: OpcionNombrada): void {
    this.proveedor.set(opcion);
    this.cliente.set(null);
    this.buscadorCliente.limpiar();
  }

  quitarCliente(): void {
    this.cliente.set(null);
    this.buscadorCliente.limpiar();
  }

  quitarProveedor(): void {
    this.proveedor.set(null);
    this.buscadorProveedor.limpiar();
  }

  ponerDescripcion(valor: string): void {
    this.descripcion.set(valor);
  }

  ponerFactura(valor: boolean): void {
    this.tieneFactura.set(valor);
  }

  /** Vuelve a la lista; si hay algo a medias, primero avisa. */
  volverALista(): void {
    if (this.editor().monto !== '' && !confirmar('Se pierde el movimiento que llevas capturado.')) {
      return;
    }
    this.detalle.set(null);
    this.errorDetalle.set(null);
    this.pantalla.set('lista');
  }

  // --------------------------------------------------------------- el guardado
  async guardar(): Promise<void> {
    if (!this.puedeGuardar()) return;

    this.guardando.set(true);
    this.errorCaptura.set(null);
    try {
      const movimiento = await this.api.crearMovimiento(
        cuerpoDeMovimiento(
          this.editor(),
          this.cliente(),
          this.proveedor(),
          this.fecha(),
          this.descripcion(),
          this.tieneFactura(),
        ),
      );
      this.detalle.set(movimiento);
      this.pantalla.set('detalle');
      // El saldo lo recalculo el trigger, asi que las cuentas y el resumen se
      // vuelven a pedir: el numero que se ve no se calcula aqui.
      await Promise.all([this.cargar(), this.cargarResumen()]);
    } catch (falla) {
      this.errorCaptura.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  // --------------------------------------------------------------- el detalle
  async ver(id: number): Promise<void> {
    this.errorLista.set(null);
    try {
      this.detalle.set(await this.api.obtenerMovimiento(id));
      this.errorDetalle.set(null);
      this.montoParaBorrar.set('');
      this.confirmandoBorrado.set(false);
      this.pantalla.set('detalle');
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    }
  }

  pedirBorrado(): void {
    this.montoParaBorrar.set('');
    this.errorDetalle.set(null);
    this.confirmandoBorrado.set(true);
  }

  noBorrar(): void {
    this.confirmandoBorrado.set(false);
    this.montoParaBorrar.set('');
  }

  /**
   * Escribir el monto es lo que desbloquea el borrado.
   *
   * Un `confirm` de una linea se acepta sin leer, y este es el unico borrado
   * del proyecto: no hay documento que lo respalde ni forma de rehacerlo. El
   * monto esta a la vista justo encima, asi que escribirlo es rapido y
   * obliga a mirar.
   */
  readonly montoCoincide = computed(() => {
    const movimiento = this.detalle();
    if (movimiento === null) return false;
    const escrito = this.montoParaBorrar().trim().replace(',', '.');
    return escrito !== '' && Number(escrito) === movimiento.monto;
  });

  async confirmarBorrado(): Promise<void> {
    const movimiento = this.detalle();
    if (movimiento === null || !this.montoCoincide() || this.borrando()) return;

    this.borrando.set(true);
    this.errorDetalle.set(null);
    try {
      await this.api.eliminarMovimiento(movimiento.id);
      this.detalle.set(null);
      this.confirmandoBorrado.set(false);
      this.montoParaBorrar.set('');
      this.exito.set(`Se borro el movimiento de ${montoComoTexto(movimiento.monto)}.`);
      // El DELETE responde 204 sin cuerpo. El saldo de la cuenta lo rehizo el
      // trigger, asi que se vuelve a pedir todo en vez de restar a mano.
      await Promise.all([this.cargar(), this.cargarResumen()]);
      this.pantalla.set('lista');
    } catch (falla) {
      this.errorDetalle.set(errorLegible(falla).mensaje);
    } finally {
      this.borrando.set(false);
    }
  }

  // ------------------------------------------------------ el alta de una cuenta
  verCuentas(): void {
    this.errorAltaCuenta.set(null);
    this.pantalla.set('cuentas');
  }

  nuevaCuenta(): void {
    this.nombreCuenta.set('');
    this.tipoCuenta.set('efectivo');
    this.bancoCuenta.set('');
    this.titularCuenta.set('');
    this.errorAltaCuenta.set(null);
  }

  cambiarTipoCuenta(valor: string): void {
    this.tipoCuenta.set(valor as TipoCuenta);
  }

  ponerNombreCuenta(valor: string): void {
    this.nombreCuenta.set(valor);
  }

  ponerBanco(valor: string): void {
    this.bancoCuenta.set(valor);
  }

  ponerTitular(valor: string): void {
    this.titularCuenta.set(valor);
  }

  async guardarCuenta(): Promise<void> {
    if (!this.puedeGuardarCuenta()) return;

    this.guardandoCuenta.set(true);
    this.errorAltaCuenta.set(null);
    try {
      const cuenta = await this.api.crearCuenta(
        cuerpoDeCuenta(
          this.nombreCuenta(),
          this.tipoCuenta(),
          this.bancoCuenta(),
          this.titularCuenta(),
        ),
      );
      this.nuevaCuenta();
      this.exito.set(`Se abrio la cuenta «${cuenta.nombre}».`);
      await this.cargar();
    } catch (falla) {
      // `CUENTA_DUPLICADA` ya viene con el nombre repetido en el mensaje,
      // asi que no hay nada que traducir.
      this.errorAltaCuenta.set(errorLegible(falla).mensaje);
    } finally {
      this.guardandoCuenta.set(false);
    }
  }

  // ----------------------------------------------------------------- el texto
  // Los simbolos que la plantilla usa como metodo de la clase.
  montoComoTexto = montoComoTexto;
  saldoNegativo = saldoNegativo;
}

/**
 * `confirm` para lo unico que se pierde sin avisar.
 *
 * Va en un envoltorio para que, si algun dia se cambia a un `dialog` propio, se
 * cambie en un solo lugar.
 */
function confirmar(pregunta: string): boolean {
  return window.confirm(pregunta);
}
