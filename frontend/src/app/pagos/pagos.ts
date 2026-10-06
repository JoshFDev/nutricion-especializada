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
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import { montoComoTexto } from '../nucleo/cifras';
import { ConfirmModal } from '../productos/confirm-modal';
import {
  cuerpoDePago,
  hoyComoTexto,
  montoDeAplicaciones,
  problemaDeAplicacion,
  PagosApi,
  METODOS_PAGO,
  type AplicacionEditor,
  type MetodoPago,
  type Pago,
  type PagoListado,
} from './pagos-api';

/**
 * La cobranza: qué se cobró, a qué notas y cómo.
 *
 * La MISMA pantalla que clientes, proveedores, compras, productos y el
 * catálogo: cabecera con la acción principal, editor inline que se despliega
 * ARRIBA de la tabla, barra de filtros, tabla con animaciones, estados vacíos
 * y paginación. El diseño sale de `nucleo/pantallas.scss`.
 *
 * El pago es dinero que YA entró, así que esto no es "facturar": es dejar
 * registrado qué dio el cliente y a qué notas se reparte. Por eso el editor
 * tiene dos pasos en una vista:
 *
 *   1. Se elige el cliente, el método y el monto.
 *   2. Se reparte entre sus notas abiertas. Un pago sin aplicaciones es un
 *      abono a cuenta, y es válido: el saldo (monto − aplicado) se ve mientras
 *      se captura, y la base lo recalcula al guardar.
 *
 * El detalle de un pago se despliega DEBAJO de su fila, no en otra pantalla,
 * como en compras: la lista es la que dice si el cliente está al corriente y
 * el detalle es la explicación de UN pago.
 *
 * Tres cosas que conviene tener presentes:
 *
 *   - **Un pago no se borra ni se corrige.** El backend no tiene PATCH ni
 *     DELETE: un pago mal capturado se arregla cancelando la nota que cubría,
 *     no borrando, y queda el rastro. Por eso aquí no hay edición: hay Ver.
 *   - **Lo que no se aplica es dinero real.** El saldo sin aplicar se descuenta
 *     del saldo del cliente (`fn_recalcular_saldo_cliente`), así que tiene que
 *     estar a la vista o el operador no sabe que hay un abono flotando.
 *   - **Cada aplicación se valida DOS veces**, como en el POS: aquí con el
 *     subtotal (el editor sabe cuánto vale cada nota), y en el backend contra
 *     el saldo REAL de la nota (una parcial ya trae cobrado). Es el mismo
 *     acuerdo de `problemaDeAplicacion`: el frontend avisa lo que puede y el
 *     backend comprueba lo que sabe.
 */

@Component({
  selector: 'app-pagos',
  templateUrl: './pagos.html',
  styleUrl: './pagos.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmModal],
  animations: [filasAnimation],
})
export class Pagos {
  private readonly api = inject(PagosApi);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  readonly confirmModal = viewChild.required(ConfirmModal);

  // --------------------------------------------------------------- el listado
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly listado = signal<PagoListado[]>([]);
  readonly total = signal(0);
  readonly cargando = signal(false);
  readonly errorLista = signal<string | null>(null);

  readonly filtroTexto = signal('');
  readonly filtroMetodo = signal<'' | MetodoPago>('');
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

  readonly paginasTotales = computed(() => Math.max(1, Math.ceil(this.total() / this.limite())));
  readonly hayPaginaAnterior = computed(() => this.pagina() > 1);
  readonly hayPaginaSiguiente = computed(() => this.pagina() < this.paginasTotales());

  /** Lo que ve en la barra: "1-25 de 1,240". */
  readonly rangoDePagina = computed(() => {
    const total = this.total();
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
      this.filtroMetodo() !== '' ||
      this.filtroDesde() !== '' ||
      this.filtroHasta() !== '',
  );

  // -------------------------------------------------------------- el editor
  /**
   * El alta vive dentro de la lista, como el editor de las demás pantallas.
   *
   * Empieza cerrada: lo que se ve casi siempre son los pagos cobrados, y el
   * cobro se abre a propósito.
   */
  readonly editorVisible = signal(false);

  readonly cliente = signal<{ id: number; nombre: string } | null>(null);
  readonly resultadosCliente = signal<{ id: number; nombre: string }[]>([]);
  readonly buscandoCliente = signal(false);
  readonly cargandoNotas = signal(false);

  readonly fecha = signal(hoyComoTexto());
  readonly metodoPago = signal<'' | MetodoPago>('');
  readonly monto = signal('');
  readonly referencia = signal('');
  readonly requiereFactura = signal(false);
  readonly aplicaciones = signal<AplicacionEditor[]>([]);

  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);

  /** Si el editor tiene algo escrito que se pierde al cerrarlo. */
  private hayCaptura = computed(() => this.cliente() !== null || this.monto().trim() !== '');

  readonly aplicado = computed(() => montoDeAplicaciones(this.aplicaciones()));
  readonly montoNumero = computed(() => {
    const numero = Number(this.monto().trim().replace(',', '.'));
    return Number.isFinite(numero) ? numero : 0;
  });
  /** Lo que no queda aplicado: el preview del abono a cuenta. */
  readonly saldo = computed(() => Math.max(this.montoNumero() - this.aplicado(), 0));
  /** Aplicar más de lo capturado no se puede: el pago no alcanza. */
  readonly alcanza = computed(
    () => this.aplicaciones().length === 0 || this.aplicado() <= this.montoNumero(),
  );

  /** Por qué no se puede guardar todavía, o `null` si sí se puede. */
  readonly problemaParaGuardar = computed(() => {
    if (!this.sesion.puede('pagos.crear')) return 'No tienes permiso para registrar pagos.';
    if (this.cliente() === null) return 'Elige el cliente que pagó.';
    if (this.montoNumero() <= 0) return 'Escribe el monto del pago.';
    if (!this.alcanza()) return 'El pago no alcanza las aplicaciones que pusiste.';
    const nota = this.aplicaciones().find((a) => problemaDeAplicacion(a) !== null);
    if (nota) return `Revisa lo que aplicas a la nota ${nota.folio}.`;
    return null;
  });

  readonly puedeCrear = computed(() => this.sesion.puede('pagos.crear'));

  readonly puedeGuardar = computed(() => this.problemaParaGuardar() === null && !this.guardando());

  // ------------------------------------------------------------ el detalle
  /**
   * El pago desplegado, y el id de la fila en la que se despliega.
   *
   * El id va aparte del documento porque es lo que la plantilla compara: así
   * la fila sabe si es ella la que está abierta sin tener que buscar el
   * documento entero. Solo hay uno a la vez: el detalle es largo y dos abiertos
   * taparían la tabla sin aportar nada.
   */
  readonly expandida = signal<number | null>(null);
  readonly detalle = signal<Pago | null>(null);
  readonly abriendoDetalle = signal(false);

  constructor() {
    void this.recargar();
  }

  // --------------------------------------------------------------- el listado
  private temporizadorFiltros: ReturnType<typeof setTimeout> | undefined;

  /**
   * Busca con 250 ms de espera, igual que el resto de las pantallas.
   *
   * Cada tecleo NO pega una petición: con el buscador abierto a media escritura
   * son varias y la última es la única que sirve. Además, buscar vuelve
   * siempre a la página 1, porque quedarse en la 4 con un filtro nuevo es
   * mirar un `offset` que ya no quiere decir nada.
   */
  aBuscar(texto: string): void {
    clearTimeout(this.temporizadorFiltros);
    this.filtroTexto.set(texto);
    this.temporizadorFiltros = setTimeout(() => void this.recargar(), 250);
  }

  aMetodo(valor: string): void {
    this.filtroMetodo.set(valor as '' | MetodoPago);
    void this.recargar();
  }

  aDesde(valor: string): void {
    this.filtroDesde.set(valor);
    void this.recargar();
  }

  aHasta(valor: string): void {
    this.filtroHasta.set(valor);
    void this.recargar();
  }

  /** Deja los filtros como estaban al entrar. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizadorFiltros);
    this.filtroTexto.set('');
    this.filtroMetodo.set('');
    this.filtroDesde.set('');
    this.filtroHasta.set('');
    void this.recargar();
  }

  /**
   * Vuelve a la primera página con el filtro que se tenga puesto, y cierra el
   * detalle: con filtros nuevos el pago abierto puede no estar en la página, y
   * un comprobante flotando sin su fila es peor que ninguno.
   */
  private async recargar(): Promise<void> {
    this.cerrarDetalle();
    await this.cargarPagina(1);
  }

  /** Carga una página. Es la ÚNICA forma de pedir el listado. */
  private async cargarPagina(pagina: number): Promise<void> {
    // La signal se lee UNA vez y a una variable: leída dos veces en la misma
    // expresión, TypeScript no la puede acotar y el filtro-empty se cuela en
    // el tipo del parámetro.
    const metodoElegido = this.filtroMetodo();
    this.cargando.set(true);
    this.errorLista.set(null);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        metodo: metodoElegido === '' ? undefined : metodoElegido,
        desde: this.filtroDesde() || undefined,
        hasta: this.filtroHasta() || undefined,
        limite: this.limite(),
        offset: (pagina - 1) * this.limite(),
      });
      this.listado.set(resultado.datos);
      this.recarga.marcar();
      this.total.set(resultado.total);
      this.pagina.set(pagina);

      // La fila desplegada puede no haber sobrevivido al filtro o a la página:
      // si ya no está en la tabla, su detalle se cierra solo.
      const id = this.expandida();
      if (id !== null && !resultado.datos.some((pago) => pago.id === id)) {
        this.cerrarDetalle();
      }
    } catch (falla) {
      this.listado.set([]);
      this.total.set(0);
      this.errorLista.set(errorLegible(falla).mensaje);
      this.cerrarDetalle();
    } finally {
      this.cargando.set(false);
    }
  }

  /** El mínimo de dos caracteres, como en las demás pantallas. */
  private textoBusqueda(): string | undefined {
    const limpio = this.filtroTexto().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  /** Cambia de página y sube la tabla a la vista. */
  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;

    this.cerrarDetalle();
    await this.cargarPagina(pagina);
    document.querySelector('.pagos .tabla-wrapper')?.scrollIntoView({
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

  // --------------------------------------------------------------- el editor
  /** Abre el cobro en blanco. */
  abrirEditor(): void {
    this.cliente.set(null);
    this.resultadosCliente.set([]);
    this.fecha.set(hoyComoTexto());
    this.metodoPago.set('');
    this.monto.set('');
    this.referencia.set('');
    this.requiereFactura.set(false);
    this.aplicaciones.set([]);
    this.error.set(null);
    this.editorVisible.set(true);
  }

  /**
   * Abre o cierra el cobro.
   *
   * Cerrarlo con algo escrito pasa por el modal: si ya se eligió cliente o se
   * escribió un monto, perderlo tiene que ser una decisión y no un clic.
   */
  async alternarEditor(): Promise<void> {
    if (this.editorVisible() && this.hayCaptura()) {
      const confirmado = await this.confirmModal().abrir({
        titulo: 'Descartar el cobro',
        mensaje:
          'Este pago está a medio capturar y se va a perder. ¿Cerrar de todos modos?\n\nSi solo querías revisar la lista, ciérralo y vuelve a abrirlo: el cobro sigue en blanco.',
        textoConfirmar: 'Descartar y cerrar',
        variante: 'peligro',
      });
      if (!confirmado) return;

      this.vaciarEditor();
    }

    this.editorVisible.update((visible) => !visible);
  }

  /** Cierra el cobro sin preguntar. Es lo que se usa al guardar bien. */
  private cerrarEditor(): void {
    this.vaciarEditor();
    this.editorVisible.set(false);
  }

  /** Vuelve el cobro a blanco. */
  private vaciarEditor(): void {
    this.cliente.set(null);
    this.resultadosCliente.set([]);
    this.metodoPago.set('');
    this.monto.set('');
    this.referencia.set('');
    this.requiereFactura.set(false);
    this.aplicaciones.set([]);
    this.error.set(null);
  }

  // ------------------------------------------------------------ la búsqueda
  private temporizadorCliente: ReturnType<typeof setTimeout> | undefined;

  /** Sin confirmar el texto, tras 250 ms para no buscar en cada tecla. */
  buscarCliente(texto: string): void {
    clearTimeout(this.temporizadorCliente);
    const limpio = texto.trim();
    if (limpio.length < 2) {
      this.resultadosCliente.set([]);
      return;
    }
    this.temporizadorCliente = setTimeout(async () => {
      this.buscandoCliente.set(true);
      try {
        this.resultadosCliente.set(await this.api.clientes(limpio));
      } catch {
        this.resultadosCliente.set([]);
      } finally {
        this.buscandoCliente.set(false);
      }
    }, 250);
  }

  elegirCliente(cliente: { id: number; nombre: string }): void {
    this.cliente.set(cliente);
    this.resultadosCliente.set([]);
    this.error.set(null);
    this.aplicaciones.set([]);
    void this.cargarNotas(cliente.id);
  }

  cambiarCliente(): void {
    this.cliente.set(null);
    this.resultadosCliente.set([]);
    this.aplicaciones.set([]);
  }

  async cargarNotas(clienteId: number): Promise<void> {
    this.cargandoNotas.set(true);
    try {
      this.aplicaciones.set(await this.api.notasAbiertas(clienteId));
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoNotas.set(false);
    }
  }

  /**
   * `poner*` y no `monto`: `monto` es la signal del pago.
   *
   * Se confirma con `change` (al salir del campo) y no con `input`, igual
   * que las cantidades del POS: teclear "0." para escribir "0.5" no debe
   * perderse en la primera tecla.
   */
  ponerDeNota(notaId: number, valor: string): void {
    this.aplicaciones.update((notas) =>
      notas.map((n) => (n.nota_id === notaId ? { ...n, monto: valor } : n)),
    );
  }

  /** La nota se cubre entera, con su subtotal — el monto que se ve. */
  aplicarToda(notaId: number): void {
    this.aplicaciones.update((notas) =>
      notas.map((n) => (n.nota_id === notaId ? { ...n, monto: String(n.subtotal) } : n)),
    );
  }

  // --------------------------------------------------------------- el detalle
  /**
   * Despliega el detalle DEBAJO de la fila, o lo recoge si ya estaba
   * desplegado. El mismo gesto que abrir y cerrar una fila.
   */
  async ver(pago: PagoListado): Promise<void> {
    if (this.expandida() === pago.id) {
      this.cerrarDetalle();
      return;
    }
    if (this.abriendoDetalle()) return;

    this.abriendoDetalle.set(true);
    this.errorLista.set(null);
    try {
      this.detalle.set(await this.api.obtener(pago.id));
      this.expandida.set(pago.id);
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.abriendoDetalle.set(false);
    }
  }

  /** Si la fila que se está tocando es la que está desplegada. */
  detalleAbierto(id: number): boolean {
    return this.expandida() === id;
  }

  cerrarDetalle(): void {
    this.expandida.set(null);
    this.detalle.set(null);
  }

  // ------------------------------------------------------------- el guardado
  async guardar(): Promise<void> {
    const cliente = this.cliente();
    if (cliente === null || !this.puedeGuardar()) return;

    const metodoActual = this.metodoPago();
    const metodo = metodoActual === '' ? null : metodoActual;

    // Los montos del aviso se leen ANTES de cerrar el editor: cerrarlo vacía
    // el formulario, y un "registrado con $0.00" sería una mentira.
    const montoCobrado = this.montoNumero();
    const sinAplicar = this.saldo();

    this.guardando.set(true);
    this.error.set(null);
    try {
      const cuerpo = cuerpoDePago(
        cliente.id,
        this.fecha(),
        metodo,
        this.monto(),
        this.requiereFactura(),
        this.referencia(),
        this.aplicaciones(),
      );
      await this.api.crear(cuerpo);
      this.cerrarEditor();
      this.toast.exito(
        sinAplicar > 0
          ? `Pago de ${montoComoTexto(montoCobrado)} registrado con ${montoComoTexto(sinAplicar)} sin aplicar`
          : 'Pago registrado con éxito',
      );
      await this.recargar();
    } catch (falla) {
      this.error.set(this.explicar(falla));
    } finally {
      this.guardando.set(false);
    }
  }

  /**
   * Los errores del servicio, traducidos para quien cobra.
   *
   * `MONTO_MAYOR_A_NOTA` es el que vale la pena tratar: el mensaje del backend
   * no dice de qué nota, y el `detalles` sí. La nota ya está en el editor, así
   * que su folio se pone aquí. El resto llega legible.
   */
  private explicar(falla: unknown): string {
    const legible = errorLegible(falla);
    if (legible.codigo !== 'MONTO_MAYOR_A_NOTA') return legible.mensaje;

    const datos = legible.datos as { nota_id?: number } | null;
    const nota = this.aplicaciones().find((n) => n.nota_id === datos?.nota_id);
    return nota === undefined
      ? legible.mensaje
      : `La nota ${nota.folio} ya no acepta ese monto: comprueba cuánto le falta por cobrar.`;
  }

  // ----------------------------------------------------------------- el texto
  montoComoTexto = montoComoTexto;
  METODOS_PAGO = METODOS_PAGO;
  problemaDeAplicacion = problemaDeAplicacion;
}
