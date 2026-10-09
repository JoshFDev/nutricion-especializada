import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { filasAnimation, Recarga } from '../nucleo/animaciones';
import { errorLegible } from '../nucleo/api';
import { crearBuscador } from '../nucleo/buscador';
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import { montoComoTexto } from '../nucleo/cifras';
import { ConfirmModal } from '../productos/confirm-modal';
import {
  CajaApi,
  cuerpoDeCuenta,
  cuerpoDeMovimiento,
  problemaDeCategoria,
  problemaDeDescripcion,
  problemaDeMonto,
  problemaDeNombreCuenta,
  saldoNegativo,
  totalesDeCierre,
  totalesDeResumen,
  type CategoriaEnUso,
  type CierreDeCaja,
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
 * La MISMA de compras, pagos, facturación y el catálogo: cabecera con la acción
 * principal, editor inline que se despliega ARRIBA de la tabla, barra de
 * filtros, tabla con animaciones, estados vacíos y paginación. El diseño sale
 * de `nucleo/pantallas.scss`.
 *
 * DOS vistas y no cuatro, como antes: la lista con su alta y su comprobante, y
 * las cuentas. El movimiento se captura en el editor inline y su comprobante es
 * la fila que se despliega, como en compras y en pagos; con la fila abierta la
 * tabla no se mueve y se puede comparar el movimiento abierto con los de al
 * lado, que es lo que hace falta cuando hay que revisar un saldo.
 *
 * Lo que hace distinta a las demás pantallas, y por qué:
 *
 *   - **Es el único módulo con DELETE.** En los otros, el registro tiene
 *     nombre y aparece en documentos viejos, así que se conserva y se cancela.
 *     Un movimiento de caja solo vive en `auditoria_caja`, y el permiso que lo
 *     autoriza (`caja.eliminar`) se creó desde el principio para eso. Por eso
 *     el borrado pide confirmación escribiendo el monto, no un `confirm` de
 *     una línea.
 *   - **El saldo no se toca nunca desde la pantalla.** Lo recalcula
 *     `fn_recalcular_saldo_cuenta` sumando los movimientos de la cuenta. Por
 *     eso después de guardar o de borrar se vuelven a pedir las cuentas y el
 *     resumen: el número que se muestra no es el que se calculó aquí.
 *   - **Cliente y proveedor son excluyentes.** El esquema rechaza un
 *     movimiento que sea de los dos, y los dos vacíos es legítimo (la renta
 *     del local no es de nadie). Elegir uno borra al otro en vez de dejar que
 *     el servidor lo rechace.
 *   - **La descripción es un `input` de una línea, no un `textarea`.** El
 *     esquema usa `texto()`, que rechaza los caracteres de control, y un
 *     "enter" de más sería un 422 que no menciona los saltos de línea.
 *
 * El resumen comparte las fechas con el listado y no con los demás filtros: un
 * periodo es una sola cosa en la pantalla, mientras que "solo egresos" o
 * "solo la cuenta del banco" son filtros de la tabla de abajo. Se dice en la
 * tarjeta, porque un resumen que no corresponde a lo que se está viendo es
 * como se cuadra mal un día.
 */

/** Las dos vistas que quedan: el listado con su alta, y las cuentas. */
type Pantalla = 'lista' | 'cuentas';

@Component({
  selector: 'app-caja',
  templateUrl: './caja.html',
  styleUrl: './caja.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmModal],
  animations: [filasAnimation],
})
export class Caja {
  private readonly api = inject(CajaApi);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  readonly confirmModal = viewChild.required(ConfirmModal);

  readonly pantalla = signal<Pantalla>('lista');

  /**
   * El alta de cuenta pide `caja.capturar` y no un permiso propio: la tabla
   * de permisos no tiene `caja.editar`, y crear uno solo para el admin dejaría
   * a la cajera sin poder abrir la cuenta del banco nuevo. Ver la nota de
   * `caja/rutas.ts`.
   */
  readonly puedeCrear = computed(() => this.sesion.puede('caja.capturar'));
  readonly puedeEliminar = computed(() => this.sesion.puede('caja.eliminar'));

  // ------------------------------------------------------------- las cuentas
  // Se piden siempre, también en la lista: el resumen los trae con nombre y
  // saldo, pero el formulario de la captura necesita el id de la cuenta.
  readonly cuentas = signal<Cuenta[]>([]);
  readonly errorCuentas = signal<string | null>(null);

  async cargarCuentas(): Promise<void> {
    this.errorCuentas.set(null);
    try {
      this.cuentas.set(await this.api.cuentas());
      this.recarga.marcar();
    } catch (falla) {
      this.errorCuentas.set(errorLegible(falla).mensaje);
    }
  }

  // ---------------------------------------------------------------- el resumen
  /** Una fila por cuenta, con lo que entró y salió DENTRO del periodo. */
  readonly resumenCuentas = signal<ResumenCuenta[]>([]);
  readonly cargandoResumen = signal(false);
  readonly errorResumen = signal<string | null>(null);

  /** Los tres números de arriba: lo que entró, lo que salió y la diferencia. */
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

  // ----------------------------------------------------------------- el cierre
  /**
   * El cierre de caja: el arqueo esperado de un dia.
   *
   * Va en su propia tarjeta y no comparte fechas con el resumen porque son dos
   * preguntas distintas: el resumen es un rango que se elige, y el cierre es UN
   * dia, normalmente el de hoy, y lo que deberia haber al terminarlo. Es de
   * solo lectura: no captura el conteo fisico ni la diferencia, solo dice lo
   * que la base espera.
   *
   * Empieza oculto y se calcula al abrirlo: es una consulta de otro dia, no
   * algo que haya que traer en cada carga de la lista.
   */
  readonly cierreVisible = signal(false);
  readonly cierre = signal<CierreDeCaja | null>(null);
  readonly cargandoCierre = signal(false);
  readonly errorCierre = signal<string | null>(null);
  /** El dia a cerrar. Vacio la primera vez: lo pone el backend con su "hoy". */
  readonly fechaCierre = signal('');

  readonly totalesCierre = computed(() => totalesDeCierre(this.cierre()?.cuentas ?? []));

  async abrirCierre(): Promise<void> {
    this.cierreVisible.set(true);
    await this.cargarCierre();
  }

  cerrarCierre(): void {
    this.cierreVisible.set(false);
  }

  /**
   * Pide el cierre del dia elegido.
   *
   * Sin fecha, el backend decide (hoy segun la base) y devuelve el dia que
   * cerro; se copia al campo para que el `date` muestre que dia se esta
   * mirando en vez de quedarse en blanco.
   */
  private async cargarCierre(): Promise<void> {
    this.cargandoCierre.set(true);
    this.errorCierre.set(null);
    try {
      const resultado = await this.api.cierre(this.fechaCierre() || undefined);
      this.cierre.set(resultado);
      if (this.fechaCierre() === '') this.fechaCierre.set(resultado.fecha);
    } catch (falla) {
      this.cierre.set(null);
      this.errorCierre.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoCierre.set(false);
    }
  }

  cambiarFechaCierre(valor: string): void {
    this.fechaCierre.set(valor);
    void this.cargarCierre();
  }

  // --------------------------------------------------------------- el listado
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly filas = signal<MovimientoListado[]>([]);
  readonly totalEncontrado = signal(0);
  readonly cargando = signal(false);
  readonly errorLista = signal<string | null>(null);

  readonly filtroTexto = signal('');
  readonly filtroCuenta = signal('');
  readonly filtroTipo = signal<'' | TipoMovimiento>('');
  readonly filtroCategoria = signal('');
  readonly filtroFactura = signal<'' | 'si' | 'no'>('');
  readonly filtroDesde = signal('');
  readonly filtroHasta = signal('');

  /**
   * Cuántos renglones se ven por página, y la página que se está viendo.
   *
   * La página se elige en SALTOS y se traduce a `offset` al pedir, porque un
   * `offset` guardado se queda viejo en cuanto cambia un filtro.
   */
  readonly limite = signal(25);
  readonly pagina = signal(1);

  readonly paginasTotales = computed(() =>
    Math.max(1, Math.ceil(this.totalEncontrado() / this.limite())),
  );
  readonly hayPaginaAnterior = computed(() => this.pagina() > 1);
  readonly hayPaginaSiguiente = computed(() => this.pagina() < this.paginasTotales());

  /** Lo que ve en la barra: "1-25 de 1,240". */
  readonly rangoDePagina = computed(() => {
    const total = this.totalEncontrado();
    if (total === 0) return '0 de 0';
    const desde = (this.pagina() - 1) * this.limite() + 1;
    const hasta = Math.min(this.pagina() * this.limite(), total);
    return `${desde}-${hasta} de ${total}`;
  });

  /**
   * Si la tabla lleva algo puesto, para poder ofrecer "Limpiar".
   *
   * Las fechas NO cuentan: esas son el periodo, y el resumen de arriba está
   * calculado con ellas. Borrarlas sería quitarle el periodo a la tarjeta sin
   * querer. El buscador se cuenta con dos caracteres porque es lo que el
   * backend exige.
   */
  readonly hayFiltros = computed(
    () =>
      this.filtroTexto().trim().length >= 2 ||
      this.filtroCuenta() !== '' ||
      this.filtroTipo() !== '' ||
      this.filtroCategoria() !== '' ||
      this.filtroFactura() !== '',
  );

  // --------------------------------------------------------------- la captura
  /**
   * El alta vive dentro de la lista, como el editor de las demás pantallas.
   *
   * Empieza cerrada: lo que se ve casi siempre son los movimientos, y el alta
   * se abre a propósito.
   */
  readonly editorVisible = signal(false);

  readonly editor = signal({
    cuenta_id: null as number | null,
    tipo: 'egreso' as TipoMovimiento,
    categoria: '',
    monto: '',
  });
  /**
   * El cliente y el proveedor elegidos, con su nombre.
   *
   * Se guardan como opción y no solo como id porque el campo tiene que poder
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
   * que cero) para que el 422 no llegue por escribir "0" o un número con tres
   * decimales. La categoría igual, con su mínimo de dos.
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

  /** Si el editor tiene algo escrito que se pierde al cerrarlo. */
  private readonly hayCaptura = computed(
    () => this.editor().monto !== '' || this.editor().categoria !== '',
  );

  readonly puedeGuardar = computed(
    () => this.problemas().length === 0 && this.puedeCrear() && !this.guardando(),
  );

  // ---------------------------------------------------------------- el detalle
  /**
   * El movimiento desplegado, y el id de la fila en la que se despliega.
   *
   * El id va aparte del documento porque es lo que la plantilla compara: así
   * la fila sabe si es ella la que está abierta sin tener que buscar el
   * documento entero. Solo hay uno a la vez: el comprobante es largo y dos
   * abiertos taparían la tabla sin aportar nada.
   */
  readonly expandida = signal<number | null>(null);
  readonly detalle = signal<Movimiento | null>(null);
  readonly abriendoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly borrando = signal(false);
  /** El borrado se confirma escribiendo el monto, no con un `confirm`. */
  readonly confirmandoBorrado = signal(false);
  readonly montoParaBorrar = signal('');

  /** Si la fila que se está tocando es la que está desplegada. */
  detalleAbierto(id: number): boolean {
    return this.expandida() === id;
  }

  // ---------------------------------------------------------- las cuentas (alta)
  /** El alta de una cuenta también es un editor, y también empieza cerrada. */
  readonly cuentaEditorVisible = signal(false);

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
    void this.cargar(true);
  }

  /**
   * Todo lo de la lista, junto. El resumen y las cuentas van siempre.
   *
   * `inicio` es para volver a la primera página: se usa al entrar y cuando
   * cambia un filtro. Después de guardar o de borrar no: el movimiento nuevo
   * o el borrado están en la página donde ya se estaba mirando, y saltar a la
   * primera sería mover la tabla debajo del cursor sin avisar.
   */
  private async cargar(inicio = false): Promise<void> {
    await Promise.all([
      this.cargarCuentas(),
      this.cargarResumen(),
      // El cierre solo se refresca si su tarjeta esta a la vista: si no, seria
      // otra consulta por cada alta o borrado sin que nadie la este mirando.
      this.cierreVisible() ? this.cargarCierre() : Promise.resolve(),
      this.cargarPagina(inicio ? 1 : this.pagina()),
    ]);
  }

  // --------------------------------------------------------------- el listado
  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /**
   * Busca con 250 ms de espera, como el resto de las pantallas.
   *
   * Cada tecleo NO pega una petición: con el buscador abierto a media escritura
   * son varias y la última es la única que sirve. Además, buscar vuelve
   * siempre a la página 1, porque quedarse en la 4 con un filtro nuevo es
   * mirar un `offset` que ya no quiere decir nada.
   */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.filtroTexto.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  /** El mínimo de dos caracteres, como en proveedores y clientes. */
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
    // El resumen comparte el periodo, así que también se recarga.
    void Promise.all([this.recargar(), this.cargarResumen()]);
  }

  cambiarHasta(valor: string): void {
    this.filtroHasta.set(valor);
    void Promise.all([this.recargar(), this.cargarResumen()]);
  }

  /**
   * Quita todos los filtros de la tabla, no las fechas: esas son el periodo.
   */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.filtroTexto.set('');
    this.filtroCuenta.set('');
    this.filtroTipo.set('');
    this.filtroCategoria.set('');
    this.filtroFactura.set('');
    void this.recargar();
  }

  /**
   * Vuelve a la primera página con el filtro que se tenga puesto, y cierra el
   * comprobante: con filtros nuevos el movimiento abierto puede no estar en la
   * página, y un comprobante flotando sin su fila es peor que ninguno.
   */
  private async recargar(): Promise<void> {
    this.cerrarDetalle();
    await this.cargarPagina(1);
  }

  /** Carga una página. Es la ÚNICA forma de pedir el listado. */
  private async cargarPagina(pagina: number): Promise<void> {
    this.cargando.set(true);
    this.errorLista.set(null);
    try {
      const resultado = await this.api.movimientos(this.filtros(pagina));
      this.filas.set(resultado.datos);
      this.recarga.marcar();
      this.totalEncontrado.set(resultado.total);
      this.pagina.set(pagina);

      // La fila desplegada puede no haber sobrevivido al filtro o a la página:
      // si ya no está en la tabla, su comprobante se cierra solo.
      const id = this.expandida();
      if (id !== null && !resultado.datos.some((movimiento) => movimiento.id === id)) {
        this.cerrarDetalle();
      }
    } catch (falla) {
      this.filas.set([]);
      this.totalEncontrado.set(0);
      this.errorLista.set(errorLegible(falla).mensaje);
      this.cerrarDetalle();
    } finally {
      this.cargando.set(false);
    }
  }

  /** Cambia de página y sube la tabla a la vista. */
  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;

    this.cerrarDetalle();
    await this.cargarPagina(pagina);
    document.querySelector('.caja .listado')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  /** El tamaño de página como texto, para el `[value]` del desplegable. */
  limiteComoTexto(): string {
    return String(this.limite());
  }

  /** Cambia cuántos renglones se ven por página. */
  aTamanoDePagina(valor: string): void {
    const limite = Number(valor);
    if (!Number.isFinite(limite) || limite <= 0 || limite === this.limite()) return;

    this.limite.set(limite);
    this.cerrarDetalle();
    // Vuelve SIEMPRE a la página 1: quedarse en la 7 y pasar de 25 a 50 filas
    // es pedir un `offset` que ya no corresponde a nada.
    void this.cargarPagina(1);
  }

  /**
   * `con_factura` es el único filtro que viaja como texto 'true'/'false'.
   *
   * El esquema lo declara como `z.enum(['true','false'])` y lo transforma a
   * booleano: mandar el booleano de JavaScript sería un 400, porque `true` no
   * es el texto "true". Por eso la api lo recibe como `boolean` y lo
   * convierte al mandar la petición.
   */
  private facturaPedida(): boolean | undefined {
    const actual = this.filtroFactura();
    if (actual === 'si') return true;
    if (actual === 'no') return false;
    return undefined;
  }

  /** Los filtros comunes a la carga y a la paginación. */
  private filtros(pagina: number): NonNullable<Parameters<CajaApi['movimientos']>[0]> {
    return {
      buscar: this.textoBusqueda(),
      cuenta_id: this.filtroCuenta() === '' ? undefined : Number(this.filtroCuenta()),
      tipo: this.filtroTipo() || undefined,
      categoria: this.filtroCategoria().trim() || undefined,
      con_factura: this.facturaPedida(),
      desde: this.filtroDesde() || undefined,
      hasta: this.filtroHasta() || undefined,
      limite: this.limite(),
      offset: (pagina - 1) * this.limite(),
    };
  }

  // --------------------------------------------------------------- la captura
  /**
   * Abre el alta en blanco. El egreso es el primero: es lo que más se captura.
   *
   * La cuenta se queda con la primera que hay, para que el desplegable no abra
   * en "--" con dos cuentas en la lista y toque elegir antes de escribir el
   * monto. Si no hay ninguna cuenta, el selector sale con su "--" y el botón de
   * guardar no se habilita: sin cuenta no hay dónde anotar el movimiento.
   */
  nueva(): void {
    this.descartarCaptura();
    this.editorVisible.set(true);
  }

  /**
   * Abre o cierra el alta.
   *
   * Cerrarla con algo capturado pasa por el modal: si ya se escribió el monto o
   * la categoría, perderlo tiene que ser una decisión y no un clic.
   */
  async alternarEditor(): Promise<void> {
    if (this.editorVisible() && this.hayCaptura()) {
      const confirmado = await this.confirmModal().abrir({
        titulo: 'Descartar la captura',
        mensaje:
          'Este movimiento está a medio capturar y se va a perder. ¿Cerrar de todos modos?\n\nSi solo querías revisar la lista, ciérralo y vuelve a abrirlo: el alta sigue en blanco.',
        textoConfirmar: 'Descartar y cerrar',
        variante: 'peligro',
      });
      if (!confirmado) return;

      this.descartarCaptura();
    }

    this.editorVisible.update((visible) => !visible);
  }

  /** Vuelve el alta a blanco. La cuenta se queda con la primera que hay. */
  private descartarCaptura(): void {
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
  }

  /** Las categorías que ya se usan, para el `datalist` del campo. */
  private async cargarCategorias(): Promise<void> {
    const cuenta = this.editor().cuenta_id;
    try {
      this.categorias.set(await this.api.categorias(cuenta === null ? undefined : cuenta));
    } catch {
      // Las categorías son una ayuda, no un dato: si fallan, el campo se sigue
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
   * Elegir un cliente borra al proveedor, y al revés.
   *
   * El esquema rechaza un movimiento que tenga los dos, y dejarlos se
   * llenando para que el servidor avise al final es peor que decidir aquí que
   * un movimiento es de UNO. Los dos vacíos sí es legítimo: la renta del local
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

  // --------------------------------------------------------------- el guardado
  /**
   * Guarda y enseña el comprobante en su propia fila.
   *
   * El saldo lo recalculó el trigger, así que las cuentas y el resumen se
   * vuelven a pedir: el número que se ve no se calcula aquí.
   */
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
      this.descartarCaptura();
      this.editorVisible.set(false);
      this.toast.exito(`Movimiento de ${montoComoTexto(movimiento.monto)} registrado`);

      await this.cargar();
      // Se despliega lo que devolvió el alta: pedir el detalle otra vez sería
      // una segunda ida al servidor por lo mismo. Si el movimiento no está en
      // la página que se está viendo, su fila no está y no se despliega.
      if (this.filas().some((otra) => otra.id === movimiento.id)) {
        this.detalle.set(movimiento);
        this.expandida.set(movimiento.id);
      }
    } catch (falla) {
      this.errorCaptura.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  // ---------------------------------------------------------------- el detalle
  /**
   * Despliega el comprobante DEBAJO de la fila, o lo recoge si ya estaba
   * desplegado. El mismo gesto que abrir y cerrar una fila.
   */
  async ver(id: number): Promise<void> {
    if (this.expandida() === id) {
      this.cerrarDetalle();
      return;
    }
    if (this.abriendoDetalle()) return;

    this.abriendoDetalle.set(true);
    this.errorLista.set(null);
    try {
      this.detalle.set(await this.api.obtenerMovimiento(id));
      this.expandida.set(id);
      this.montoParaBorrar.set('');
      this.confirmandoBorrado.set(false);
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.abriendoDetalle.set(false);
    }
  }

  /** Recoge el comprobante. */
  cerrarDetalle(): void {
    this.expandida.set(null);
    this.detalle.set(null);
    this.errorDetalle.set(null);
    this.confirmandoBorrado.set(false);
    this.montoParaBorrar.set('');
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
   * Un `confirm` de una línea se acepta sin leer, y este es el único borrado
   * del proyecto: no hay documento que lo respalde ni forma de rehacerlo. El
   * monto está a la vista justo encima, así que escribirlo es rápido y
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
      this.cerrarDetalle();
      this.toast.exito(`Se borró el movimiento de ${montoComoTexto(movimiento.monto)}.`);
      // El DELETE responde 204 sin cuerpo. El saldo de la cuenta lo rehizo el
      // trigger, así que se vuelve a pedir todo en vez de restar a mano.
      await this.cargar();
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

  volverALista(): void {
    this.pantalla.set('lista');
  }

  nuevaCuenta(): void {
    this.nombreCuenta.set('');
    this.tipoCuenta.set('efectivo');
    this.bancoCuenta.set('');
    this.titularCuenta.set('');
    this.errorAltaCuenta.set(null);
    this.cuentaEditorVisible.set(false);
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

  /**
   * Abrir una cuenta es como abrir un movimiento: se pregunta antes de perder
   * lo que ya se escribió.
   */
  async alternarEditorCuenta(): Promise<void> {
    if (this.cuentaEditorVisible() && this.hayDatosDeCuenta()) {
      const confirmado = await this.confirmModal().abrir({
        titulo: 'Descartar la cuenta',
        mensaje: 'Esta cuenta está a medio capturar y se va a perder. ¿Cerrar de todos modos?',
        textoConfirmar: 'Descartar y cerrar',
        variante: 'peligro',
      });
      if (!confirmado) return;

      this.nuevaCuenta();
    }

    this.cuentaEditorVisible.update((visible) => !visible);
  }

  /** Si el alta de la cuenta tiene algo escrito. */
  private hayDatosDeCuenta(): boolean {
    return this.nombreCuenta().trim() !== '' || this.bancoCuenta().trim() !== '';
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
      this.toast.exito(`Se abrió la cuenta «${cuenta.nombre}».`);
      // La cuenta nueva entra en el desplegable del editor y en el filtro, así
      // que las cuentas se vuelven a pedir; el resumen también, porque ahora
      // hay una fila más en la tarjeta del periodo.
      await this.cargar();
    } catch (falla) {
      // `CUENTA_DUPLICADA` ya viene con el nombre repetido en el mensaje,
      // así que no hay nada que traducir.
      this.errorAltaCuenta.set(errorLegible(falla).mensaje);
    } finally {
      this.guardandoCuenta.set(false);
    }
  }

  // ----------------------------------------------------------------- el texto
  // Los símbolos que la plantilla usa como método de la clase.
  montoComoTexto = montoComoTexto;
  saldoNegativo = saldoNegativo;

  /**
   * El día en que se registró el movimiento, sin la hora.
   *
   * `creado_en` llega como texto de `TIMESTAMP` ("2026-10-05 12:34:56.789"), y se
   * recorta en el componente en vez de con un pipe por dos razones: la app no
   * usa pipes de fecha en ninguna pantalla (ver `nucleo/`), y recortar el texto
   * no pasa por `new Date()`, que es lo que haria que la fecha se corra un día
   * para quien esta al otro lado del meridiano. Los diez primeros caracteres ya
   * son el día, en el orden en que los guarda la base.
   */
  fechaDeRegistro(marca: string): string {
    return marca.slice(0, 10);
  }
}
