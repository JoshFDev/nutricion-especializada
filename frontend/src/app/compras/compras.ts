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
import { bultosComoTexto, kilosComoTexto, montoComoTexto } from '../nucleo/cifras';
import { ConfirmModal } from '../productos/confirm-modal';
import {
  ComprasApi,
  cuerpoDeCompra,
  estatusComoTexto,
  type Almacen,
  type Compra,
  type CompraListada,
  type EstatusCompra,
  type ProductoOpcion,
  type ProveedorOpcion,
} from './compras-api';
import {
  agregar,
  cambiarCantidad,
  cambiarKilos,
  kilosDeLinea,
  kilosDeLineas,
  lineaVacia,
  lineaValida,
  montoDeLinea,
  ponerPrecio,
  problemasDe,
  quitar,
  sinCostoEscrito,
  totalDeLineas,
  type LineaCompra,
} from './linea';

/**
 * La pantalla de compras.
 *
 * La MISMA de clientes, proveedores, productos y el catálogo: cabecera con la
 * acción principal, editor inline que se despliega ARRIBA de la tabla, barra de
 * filtros, tabla con animaciones, estados vacíos y paginación. El diseño sale
 * de `nucleo/pantallas.scss`.
 *
 * El comprobante se abre DEBAJO de la fila, como una fila que se despliega, y
 * no en otra vista. Antes salía a otra pantalla y eso tenía dos problemas que
 * se notaban enseguida: al abrirlo se iba la lista de la vista (en una
 * pantalla angosta había que subir a buscarla otra vez), y no había forma de
 * comparar la compra abierta con las de al lado. Con la fila desplegada la
 * tabla no se mueve, el contexto se queda, y en una pantalla angosta el
 * comprobante baja con scroll normal en vez de saltar a otro lado.
 *
 * Por lo mismo, ya no hay dos vistas ni routes: la compra se captura en el
 * editor inline y su comprobante es la fila que se despliega. El que guarda
 * también ve el comprobante, en la misma tabla.
 *
 * Cuatro decisiones que conviene tener presentes:
 *
 *   - **No hay editar.** Una compra se deshace CANCELÁNDOLA con un motivo, no
 *     editando renglones: editarlos dejaría el inventario con la entrada vieja
 *     y la nueva. La cancelación la bloquea el backend si ya hay pagos
 *     (`COMPRA_CON_PAGO`), y la pantalla lo explica.
 *   - **No hay borrar.** Cancelar deja el documento con estatus 'cancelada' y
 *     devuelve los bultos a la bodega por trigger.
 *   - **El costo se puede dejar vacío.** Si no se escribe, lo resuelve el
 *     backend con el último costo de ESE proveedor (`producto_proveedor_precios`),
 *     y por eso el total de la captura es un preview que avisa cuando hay
 *     renglones sin costo (ver `haySinCosto`).
 *   - **El listado pagina de verdad.** Antes tenía "cargar más", que pegaba las
 *     siguientes al final: con el filtro de fechas abierto se acababa con una
 *     tabla de cuatro pantallas sin forma de volver arriba.
 */

@Component({
  selector: 'app-compras',
  templateUrl: './compras.html',
  styleUrl: './compras.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmModal],
  animations: [filasAnimation],
})
export class Compras {
  private readonly api = inject(ComprasApi);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  /** Cancelar pide `compras.crear` (así lo exige el trigger de la base). */
  readonly puedeCrear = computed(() => this.sesion.puede('compras.crear'));

  readonly confirmModal = viewChild.required(ConfirmModal);

  // --------------------------------------------------------------- el listado
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly filas = signal<CompraListada[]>([]);
  readonly totalEncontrado = signal(0);
  readonly cargando = signal(false);
  readonly errorLista = signal<string | null>(null);

  readonly filtroTexto = signal('');
  readonly filtroEstatus = signal<'todos' | EstatusCompra>('todos');
  readonly filtroDesde = signal('');
  readonly filtroHasta = signal('');
  readonly filtroProveedor = signal<ProveedorOpcion | null>(null);

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
   * Si el listado lleva algo puesto, para poder ofrecer "Limpiar".
   *
   * El buscador se cuenta con dos caracteres porque es lo que el backend
   * exige: con uno solo no filtra, y un "Limpiar" que aparece a la primera
   * letra confunde más de lo que ayuda.
   */
  readonly hayFiltros = computed(
    () =>
      this.filtroTexto().trim().length >= 2 ||
      this.filtroEstatus() !== 'todos' ||
      this.filtroProveedor() !== null ||
      this.filtroDesde() !== '' ||
      this.filtroHasta() !== '',
  );

  readonly buscadorFiltroProveedor = crearBuscador({
    cargar: (texto) => this.api.proveedores(texto),
    minimo: 2,
    nada: (texto) => `Ningún proveedor coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirFiltroProveedor(opcion),
  });

  // --------------------------------------------------------------- la captura
  /**
   * El alta vive dentro de la lista, como el editor de las demás pantallas.
   *
   * Empieza cerrada: lo que se ve casi siempre son las compras, y el alta se
   * abre a propósito.
   */
  readonly editorVisible = signal(false);

  readonly proveedor = signal<ProveedorOpcion | null>(null);
  readonly fecha = signal('');
  readonly folio = signal('');
  readonly lineas = signal<LineaCompra[]>([]);
  readonly guardando = signal(false);
  readonly errorCaptura = signal<string | null>(null);

  /**
   * La bodega a donde entra la mercancia.
   *
   * Se elige en el alta con un selector (no es una constante): las bodegas
   * viven en el catalogo (`/api/almacenes`) y el operador ve cual elige.
   * Si no hay ninguna, el alta ofrece crear una en el acto a quien tenga
   * `almacenes.crear` — el administrador. Sin bodega, el guardado se
   * bloquea con un aviso en vez de mandar un "almacen 1" que el backend va
   * a rechazar con un error raro.
   */
  readonly almacenes = signal<Almacen[]>([]);
  /** El id de la bodega elegida; `null` cuando no hay ninguna. */
  readonly almacenId = signal<number | null>(null);
  /** La bodega elegida, o `null` si no hay ninguna o no se ha elegido. */
  readonly almacen = computed(
    () => this.almacenes().find((a) => a.id === this.almacenId()) ?? null,
  );

  /** El nombre que se teclea para crear la primera bodega en el mismo alta. */
  readonly nuevaBodega = signal('');
  readonly creandoBodega = signal(false);
  readonly errorBodega = signal<string | null>(null);
  /** Solo quien pueda, ve el formulario de crearla: una bodega es config. */
  readonly puedeCrearBodega = computed(() => this.sesion.puede('almacenes.crear'));

  readonly buscadorProveedor = crearBuscador({
    cargar: (texto) => this.api.proveedores(texto),
    minimo: 2,
    nada: (texto) => `Ningún proveedor coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirProveedor(opcion),
  });

  readonly buscadorProducto = crearBuscador({
    cargar: (texto) => this.api.productos(texto),
    minimo: 1,
    nada: (texto) => `Ningún producto coincide con «${texto}».`,
    alElegir: (opcion) => this.agregarProducto(opcion),
  });

  readonly hayLineas = computed(() => this.lineas().length > 0);
  readonly total = computed(() => totalDeLineas(this.lineas()));
  readonly kilos = computed(() => kilosDeLineas(this.lineas()));
  readonly haySinCosto = computed(() => this.lineas().some(sinCostoEscrito));

  /** Por qué no se puede guardar todavía, o `null` si sí se puede. */
  readonly problemaParaGuardar = computed(() => {
    if (this.proveedor() === null) return 'Elige el proveedor de la compra.';
    if (this.almacen() === null) {
      return 'No hay una bodega configurada todavía. Créala en Catálogo › Almacenes.';
    }
    if (!this.hayLineas()) return 'Agrega al menos un producto.';
    const renglon = this.lineas().find((linea) => !lineaValida(linea));
    if (renglon) return `Revisa el renglón de ${renglon.producto_nombre}.`;
    if (!this.puedeCrear()) return 'No tienes permiso para registrar compras.';
    return null;
  });

  readonly puedeGuardar = computed(() => this.problemaParaGuardar() === null && !this.guardando());

  // ------------------------------------------------------ el comprobante
  /**
   * La compra desplegada, y el id de la fila en la que se despliega.
   *
   * El id va aparte del documento porque es lo que la plantilla compara: así
   * la fila sabe si es ella la que está abierta sin tener que buscar el
   * documento entero.
   *
   * Solo hay una a la vez. Dos filas abiertas taparían la mitad de la tabla y
   * no aportan nada: el comprobante es largo.
   */
  readonly expandida = signal<number | null>(null);
  readonly detalle = signal<Compra | null>(null);
  readonly abriendoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly cancelando = signal(false);
  /** Marcar como pagada pasa por el modal de siempre: no se paga por error. */
  readonly pagando = signal(false);
  /** El motivo se pide en la propia pantalla, no con un `prompt`. */
  readonly pidiendoMotivo = signal(false);
  readonly motivo = signal('');

  /** Si la fila que se está tocando es la que está desplegada. */
  detalleAbierto(id: number): boolean {
    return this.expandida() === id;
  }

  constructor() {
    void this.recargar();
    void this.cargarAlmacen();
  }

  // --------------------------------------------------------------- el listado
  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /**
   * Busca con 250 ms de espera, igual que el resto de las pantallas.
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

  cambiarEstatus(valor: string): void {
    this.filtroEstatus.set(valor as 'todos' | EstatusCompra);
    void this.recargar();
  }

  cambiarDesde(valor: string): void {
    this.filtroDesde.set(valor);
    void this.recargar();
  }

  cambiarHasta(valor: string): void {
    this.filtroHasta.set(valor);
    void this.recargar();
  }

  elegirFiltroProveedor(opcion: ProveedorOpcion): void {
    this.filtroProveedor.set(opcion);
    void this.recargar();
  }

  quitarFiltroProveedor(): void {
    this.filtroProveedor.set(null);
    this.buscadorFiltroProveedor.limpiar();
    void this.recargar();
  }

  /** Deja los filtros como estaban al entrar. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.filtroTexto.set('');
    this.filtroEstatus.set('todos');
    this.filtroDesde.set('');
    this.filtroHasta.set('');
    this.filtroProveedor.set(null);
    this.buscadorFiltroProveedor.limpiar();
    void this.recargar();
  }

  /**
   * Vuelve a la primera página con el filtro que se tenga puesto, y cierra el
   * comprobón: con filtros nuevos la compra abierta puede no estar en la
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
      const resultado = await this.api.listar(this.filtros(pagina));
      this.filas.set(resultado.datos);
      this.recarga.marcar();
      this.totalEncontrado.set(resultado.total);
      this.pagina.set(pagina);

      // La fila desplegada puede no haber sobrevivido al filtro o a la página:
      // si ya no está en la tabla, su comprobante se cierra solo.
      const id = this.expandida();
      if (id !== null && !resultado.datos.some((compra) => compra.id === id)) {
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

  /**
   * La bodega a la que entra la mercancia.
   *
   * Se consulta cada vez que se abre el alta (y al entrar a la pantalla),
   * aunque ya se conozca: si el administrador la crea, la renombra o la
   * borra en otra pestana, al volver a abrir el alta ya aparecen las buenas.
   * Cuando la lista ya habia cargado y la elegida sigue viva, la seleccion
   * no se mueve.
   */
  private async cargarAlmacen(): Promise<void> {
    try {
      const lista = await this.api.almacenes();
      this.almacenes.set(lista);
      if (!lista.some((a) => a.id === this.almacenId())) {
        this.almacenId.set(lista[0]?.id ?? null);
      }
    } catch {
      // Sin bodegas (o sin conexion para leerlas) el alta se bloquea con el
      // aviso de `problemaParaGuardar`; el listado ya tiene su propio error.
      this.almacenes.set([]);
      this.almacenId.set(null);
    }
  }

  /** Cambia la bodega elegida por la del selector. */
  elegirAlmacen(valor: string): void {
    this.almacenId.set(valor === '' ? null : Number(valor));
  }

  /**
   * Crea la primera bodega desde el MISMO alta.
   *
   * Con el sistema recien entregado no hay bodega, y hacer que el operador
   * salte a Catálogo › Almacenes para crearla (o que llame a otro lado) es
   * justo lo que se queria evitar. Solo se ofrece a quien tenga el permiso;
   * el resto ve el aviso de pedirlo. Al crearla, se selecciona sola.
   */
  async crearBodega(): Promise<void> {
    const nombre = this.nuevaBodega().trim();
    if (nombre === '' || this.creandoBodega()) return;

    this.creandoBodega.set(true);
    this.errorBodega.set(null);
    try {
      const bodega = await this.api.crearAlmacen(nombre);
      this.almacenes.update((lista) => [...lista, bodega]);
      this.almacenId.set(bodega.id);
      this.nuevaBodega.set('');
    } catch (falla) {
      this.errorBodega.set(errorLegible(falla).mensaje);
    } finally {
      this.creandoBodega.set(false);
    }
  }

  /** Cambia de página y sube la tabla a la vista. */
  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;

    this.cerrarDetalle();
    await this.cargarPagina(pagina);
    document.querySelector('.compras .tabla-wrapper')?.scrollIntoView({
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

  /** Los filtros comunes a la carga y a la paginación. */
  private filtros(pagina: number): NonNullable<Parameters<ComprasApi['listar']>[0]> {
    const estatus = this.filtroEstatus();
    return {
      buscar: this.textoBusqueda(),
      proveedor_id: this.filtroProveedor()?.id,
      estatus: estatus === 'todos' ? undefined : estatus,
      desde: this.filtroDesde() || undefined,
      hasta: this.filtroHasta() || undefined,
      limite: this.limite(),
      offset: (pagina - 1) * this.limite(),
    };
  }

  // --------------------------------------------------------------- la captura
  /** Abre el alta en blanco. */
  nueva(): void {
    this.proveedor.set(null);
    this.fecha.set('');
    this.folio.set('');
    this.lineas.set([]);
    this.errorCaptura.set(null);
    this.buscadorProveedor.limpiar();
    this.buscadorProducto.limpiar();
    this.editorVisible.set(true);
    void this.cargarAlmacen();
  }

  /**
   * Abre o cierra el alta.
   *
   * Cerrarla con renglones capturados pasa por el modal: si hay algo escrito,
   * perderlo tiene que ser una decisión y no un clic.
   */
  async alternarEditor(): Promise<void> {
    if (this.editorVisible() && this.hayLineas()) {
      const confirmado = await this.confirmModal().abrir({
        titulo: 'Descartar la captura',
        mensaje:
          'Hay renglones capturados que se van a perder. ¿Cerrar de todos modos?\n\nSi solo querías revisar la lista, ciérralo y vuelve a abrirlo: el alta sigue en blanco.',
        textoConfirmar: 'Descartar y cerrar',
        variante: 'peligro',
      });
      if (!confirmado) return;

      this.descartarCaptura();
    }

    this.editorVisible.update((visible) => {
      const abriendo = !visible;
      if (abriendo) void this.cargarAlmacen();
      return !visible;
    });
  }

  /** Vuelve el alta a blanco. */
  private descartarCaptura(): void {
    this.proveedor.set(null);
    this.fecha.set('');
    this.folio.set('');
    this.lineas.set([]);
    this.errorCaptura.set(null);
    this.buscadorProveedor.limpiar();
    this.buscadorProducto.limpiar();
  }

  elegirProveedor(opcion: ProveedorOpcion): void {
    this.proveedor.set(opcion);
    this.errorCaptura.set(null);
  }

  /** Cambiar de proveedor no borra los renglones: compras no depende de él para el precio. */
  quitarProveedor(): void {
    this.proveedor.set(null);
    this.buscadorProveedor.limpiar();
  }

  agregarProducto(producto: ProductoOpcion): void {
    this.lineas.update((lineas) => agregar(lineas, lineaVacia(producto)));
    // Se limpia el campo para poder teclear el siguiente codigo de corrido.
    this.buscadorProducto.limpiar();
  }

  ponerCantidad(uid: number, valor: string): void {
    this.lineas.update((lineas) =>
      lineas.map((linea) => (linea.uid === uid ? cambiarCantidad(linea, valor) : linea)),
    );
  }

  ponerKilos(uid: number, valor: string): void {
    this.lineas.update((lineas) =>
      lineas.map((linea) => (linea.uid === uid ? cambiarKilos(linea, valor) : linea)),
    );
  }

  ponerCosto(uid: number, valor: string): void {
    this.lineas.update((lineas) =>
      lineas.map((linea) => (linea.uid === uid ? ponerPrecio(linea, valor) : linea)),
    );
  }

  quitarLinea(uid: number): void {
    this.lineas.update((lineas) => quitar(lineas, uid));
  }

  // ------------------------------------------------------ el comprobante
  /**
   * Despliega el comprobante DEBAJO de la fila, o lo recoge si ya estaba
   * desplegado.
   *
   * No cambia de pantalla y no pide nada: es el mismo gesto que abrir y cerrar
   * una fila, y el botón dice cuál de las dos cosas va a hacer.
   */
  async ver(id: number): Promise<void> {
    if (this.expandida() === id) {
      this.cerrarDetalle();
      return;
    }
    if (this.abriendoDetalle()) return;

    this.abriendoDetalle.set(true);
    this.errorDetalle.set(null);
    try {
      this.detalle.set(await this.api.consultar(id));
      this.expandida.set(id);
      this.motivo.set('');
      this.pidiendoMotivo.set(false);
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
    this.pidiendoMotivo.set(false);
    this.motivo.set('');
  }

  // --------------------------------------------------------------- el guardado
  /**
   * Guarda y enseña el comprobante en su propia fila.
   *
   * Vuelve a la página 1 antes de desplegarlo, porque la compra recién hecha es
   * la más reciente y es donde tiene que estar. Si alguien capturó una fecha
   * vieja puede quedar fuera de la primera página, y en ese caso la fila no
   * está: por eso el aviso dice "se registró", no "ya la estás viendo".
   */
  async guardar(): Promise<void> {
    const proveedor = this.proveedor();
    if (proveedor === null || !this.puedeGuardar()) return;

    this.guardando.set(true);
    this.errorCaptura.set(null);
    try {
      const compra = await this.api.crear(
        cuerpoDeCompra(proveedor.id, this.lineas(), this.almacen()!.id, this.folio(), this.fecha()),
      );
      this.descartarCaptura();
      this.editorVisible.set(false);
      this.toast.exito(`Compra #${compra.id} registrada con éxito`);

      await this.cargarPagina(1);
      // Se despliega lo que devolvió el alta, que ya trae los renglones: pedir
      // el detalle otra vez sería una segunda ida al servidor por lo mismo.
      if (this.filas().some((otra) => otra.id === compra.id)) {
        this.detalle.set(compra);
        this.expandida.set(compra.id);
      }
    } catch (falla) {
      this.errorCaptura.set(this.explicar(falla));
    } finally {
      this.guardando.set(false);
    }
  }

  pedirMotivo(): void {
    this.motivo.set('');
    this.errorDetalle.set(null);
    this.pidiendoMotivo.set(true);
  }

  noCancelar(): void {
    this.pidiendoMotivo.set(false);
    this.motivo.set('');
  }

  /** El motivo es obligatorio (mínimo 3 letras en el backend). */
  readonly puedeCancelar = computed(() => this.motivo().trim().length >= 3 && !this.cancelando());

  /**
   * Cancela y deja la fila abierta con el comprobante ya actualizado.
   *
   * El listado se recarga para que el badge de estatus cambie, pero NO se
   * recoge el comprobante: quien cancela necesita ver que la compra quedó
   * cancelada y con su motivo, y cerrarles la fila justo entonces es
   * contraproducente.
   */
  async confirmarCancelacion(): Promise<void> {
    const compra = this.detalle();
    if (compra === null || !this.puedeCancelar()) return;

    this.cancelando.set(true);
    this.errorDetalle.set(null);
    try {
      const cancelada = await this.api.cancelar(compra.id, this.motivo());
      this.detalle.set(cancelada);
      this.pidiendoMotivo.set(false);
      this.motivo.set('');
      this.toast.exito(`Compra #${cancelada.id} cancelada`);
      await this.cargarPagina(this.pagina());
    } catch (falla) {
      this.errorDetalle.set(errorLegible(falla).mensaje);
    } finally {
      this.cancelando.set(false);
    }
  }

  /**
   * Marca la compra como pagada.
   *
   * Pasa por el modal de confirmación y recarga la página para que el badge
   * de estatus cambie. Si la fila desplegada es la misma compra, su
   * comprobante se actualiza con lo que devolvió el pago.
   */
  async marcarPagada(compra: CompraListada): Promise<void> {
    if (
      this.pagando() ||
      !this.puedeCrear() ||
      compra.estatus === 'pagada' ||
      compra.estatus === 'cancelada'
    ) {
      return;
    }

    const confirmado = await this.confirmModal().abrir({
      titulo: 'Registrar el pago',
      mensaje:
        `Se registrará un abono al proveedor por ${montoComoTexto(compra.monto_total)} ` +
        `y la compra #${compra.id} quedará como pagada. ¿Continuar?`,
      textoConfirmar: 'Marcar como pagada',
    });
    if (!confirmado) return;

    this.pagando.set(true);
    this.errorLista.set(null);
    try {
      const pagada = await this.api.pagar(compra.id);
      this.toast.exito(`Compra #${pagada.id} marcada como pagada`);
      if (this.detalle()?.id === compra.id) this.detalle.set(pagada);
      await this.cargarPagina(this.pagina());
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.pagando.set(false);
    }
  }

  /**
   * El error de guardar, en el idioma del que está capturando.
   *
   * `SIN_COSTO` es el que vale la pena tratar: el mensaje del backend no dice
   * DE QUÉ producto, y la pantalla sí lo sabe (está en el renglón). Los otros
   * (`PROVEEDOR_INACTIVO`, `PRODUCTO_INACTIVO`) ya vienen claros.
   */
  private explicar(falla: unknown): string {
    const legible = errorLegible(falla);
    if (legible.codigo !== 'SIN_COSTO') return legible.mensaje;

    const datos = legible.datos as { producto_id?: number } | null;
    const linea = this.lineas().find((otra) => otra.producto_id === datos?.producto_id);
    const nombre = linea ? `${linea.producto_codigo} ${linea.producto_nombre}` : 'un producto';
    return `${nombre} no tiene costo registrado con este proveedor: escríbelo en el renglón.`;
  }

  // ----------------------------------------------------------------- el texto
  // Los símbolos que la plantilla usa como método de la clase.
  estatusComoTexto = estatusComoTexto;
  montoComoTexto = montoComoTexto;
  kilosComoTexto = kilosComoTexto;
  bultosComoTexto = bultosComoTexto;
  kilosDeLinea = kilosDeLinea;
  montoDeLinea = montoDeLinea;
  problemasDeLinea = problemasDe;
  sinCostoEscrito = sinCostoEscrito;

  readonly totalComoTexto = computed(() => montoComoTexto(this.total()));

  /**
   * La clase del badge de estatus.
   *
   * El estatus es la razón por la que se mira esta tabla —cuánto se le debe al
   * proveedor— así que va en badge y no en texto: "Cancelada" tiene que verse de
   * un vistazo, y verde es exactamente lo que NO es una compra cancelada.
   */
  claseDeEstatus(estatus: EstatusCompra): string {
    switch (estatus) {
      case 'pagada':
        return 'badge';
      case 'parcial':
        return 'badge badge-aviso';
      case 'cancelada':
        return 'badge badge-apagado';
      default:
        return 'badge badge-neutro';
    }
  }
}
