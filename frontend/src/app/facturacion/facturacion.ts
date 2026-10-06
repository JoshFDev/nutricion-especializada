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
  cuerpoDeEstatus,
  cuerpoDeFactura,
  cuantasElegidas,
  estatusComoTexto,
  estatusNotaComoTexto,
  FacturacionApi,
  montoDeNotas,
  puedePasarA,
  problemaDeMotivo,
  type EstatusFactura,
  type EstatusNota,
  type Factura,
  type FacturaListada,
  type NotaPorFacturar,
} from './facturacion-api';

/**
 * La pantalla de facturación.
 *
 * La MISMA de compras, pagos, clientes y el catálogo: cabecera con la acción
 * principal, editor inline que se despliega ARRIBA de la tabla, barra de
 * filtros, tabla con animaciones, estados vacíos y paginación. El diseño sale
 * de `nucleo/pantallas.scss`.
 *
 * Antes eran tres vistas y una signal `pantalla` que elegía entre lista,
 * captura y detalle. Ya no: la factura se arma en el editor inline y su
 * comprobante es la fila que se despliega, como el de una compra. Con la fila
 * abierta la tabla no se mueve, y se puede comparar la factura abierta con las
 * de al lado, que es justo lo que hace falta cuando hay que revisar si una nota
 * ya se facturó en otra.
 *
 * Lo que la pantalla NO hace, a propósito:
 *
 *   - **No edita.** El único PATCH del módulo es el del estatus, y el servicio
 *     tiene las transiciones escritas. Abrir un formulario de edición dejaría
 *     que la pantalla inventara estados.
 *   - **No ofrece notas ya facturadas.** No se puede saber antes de preguntar
 *     (el listado de notas no trae ese dato), así que se pide la factura y si
 *     el servidor dice que esa nota ya está en otra, se explica cuál. La
 *     pantalla no adivina: el único que sabe qué notas se han facturado es
 *     `factura_nota`, que es del servidor.
 *   - **No ofrece notas canceladas**, porque facturar mercancía que no salió
 *     es un CFDI que el SAT va a rechazar.
 *
 * Y los permisos van por separado, como en el servicio: `facturas.solicitar`
 * abre la pantalla y el botón de "Marcar emitida" y "Cancelar" pide
 * `facturas.emitir`. Si el rol no lo tiene, los botones no se ven en vez de
 * fallar al apretarlos.
 */
@Component({
  selector: 'app-facturacion',
  templateUrl: './facturacion.html',
  styleUrl: './facturacion.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmModal],
  animations: [filasAnimation],
})
export class Facturacion {
  private readonly api = inject(FacturacionApi);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);

  readonly confirmModal = viewChild.required(ConfirmModal);

  /** Solicitar una factura: la pide cualquiera que facture. */
  readonly puedeSolicitar = computed(() => this.sesion.puede('facturas.solicitar'));
  /** Emitir el CFDI o cancelar la factura: el acto que no hace la cajera. */
  readonly puedeEmitir = computed(() => this.sesion.puede('facturas.emitir'));

  // --------------------------------------------------------------- el listado
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly filas = signal<FacturaListada[]>([]);
  readonly totalEncontrado = signal(0);
  readonly cargando = signal(false);
  readonly errorLista = signal<string | null>(null);

  readonly filtroTexto = signal('');
  readonly filtroEstatus = signal<'' | EstatusFactura>('');
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
   * Si el listado lleva algo puesto, para poder ofrecer "Limpiar".
   *
   * El buscador se cuenta con dos caracteres porque es lo que el backend
   * exige: con uno solo no filtra, y un "Limpiar" que aparece a la primera
   * letra confunde más de lo que ayuda.
   */
  readonly hayFiltros = computed(
    () =>
      this.filtroTexto().trim().length >= 2 ||
      this.filtroEstatus() !== '' ||
      this.filtroDesde() !== '' ||
      this.filtroHasta() !== '',
  );

  // --------------------------------------------------------------- la captura
  /**
   * La captura vive dentro de la lista, como el editor de las demás pantallas.
   *
   * Empieza cerrada: lo que se ve casi siempre son las facturas, y la captura
   * se abre a propósito.
   */
  readonly editorVisible = signal(false);

  readonly cliente = signal<{ id: number; nombre: string } | null>(null);
  readonly notas = signal<NotaPorFacturar[]>([]);
  readonly cargandoNotas = signal(false);
  readonly fecha = signal('');
  readonly metodoPago = signal('');
  readonly guardando = signal(false);
  readonly errorCaptura = signal<string | null>(null);

  /** El preview del total. El que vale es el del servidor. */
  readonly total = computed(() => montoDeNotas(this.notas()));
  readonly elegidas = computed(() => cuantasElegidas(this.notas()));
  readonly hayNotas = computed(() => this.notas().length > 0);

  /**
   * Cuántas notas facturables tiene el cliente, todas.
   *
   * Puede ser más que las que se ofrecen: una factura no cubre más de
   * `MAX_NOTAS_POR_FACTURA` y la pantalla se queda en ese tope, así que con un
   * cliente que tiene más se ve el aviso de "se muestran N de M" en vez de
   * dejar que se marque lo que se ve y se piense que es todo.
   */
  readonly totalCandidatas = signal(0);
  readonly hayMasCandidatas = computed(() => this.totalCandidatas() > this.notas().length);

  readonly buscadorCliente = crearBuscador({
    cargar: (texto) => this.api.clientes(texto),
    minimo: 2,
    nada: (texto) => `Ningún cliente coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirCliente(opcion),
  });

  /** Si el editor tiene algo escrito que se pierde al cerrarlo. */
  private readonly hayCaptura = computed(() => this.cliente() !== null);

  /** Por qué no se puede guardar todavía, o `null` si sí se puede. */
  readonly problemaParaGuardar = computed(() => {
    if (!this.puedeSolicitar()) return 'No tienes permiso para solicitar facturas.';
    if (this.cliente() === null) return 'Elige el cliente al que se le factura.';
    if (this.elegidas() === 0) return 'Marca al menos una nota para facturar.';
    return null;
  });

  readonly puedeGuardar = computed(() => this.problemaParaGuardar() === null && !this.guardando());

  // ---------------------------------------------------------------- el detalle
  /**
   * La factura desplegada, y el id de la fila en la que se despliega.
   *
   * El id va aparte del documento porque es lo que la plantilla compara: así
   * la fila sabe si es ella la que está abierta sin tener que buscar el
   * documento entero. Solo hay una a la vez: el comprobante es largo y dos
   * abiertos taparían la tabla sin aportar nada.
   */
  readonly expandida = signal<number | null>(null);
  readonly detalle = signal<Factura | null>(null);
  readonly abriendoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly cambiando = signal(false);
  /** El motivo se pide en la propia pantalla, no con un `prompt`. */
  readonly pidiendoMotivo = signal(false);
  readonly motivo = signal('');

  /** Si la fila que se está tocando es la que está desplegada. */
  detalleAbierto(id: number): boolean {
    return this.expandida() === id;
  }

  /** Emitir solo tiene sentido en una solicitada, y con el permiso de emitir. */
  readonly puedeEmitirFactura = computed(() => {
    const factura = this.detalle();
    return factura !== null && this.puedeEmitir() && puedePasarA(factura.estatus, 'emitida');
  });
  /** Cancelar es lo único que hay desde emitida, y también pide el permiso. */
  readonly puedeCancelarFactura = computed(() => {
    const factura = this.detalle();
    return factura !== null && this.puedeEmitir() && puedePasarA(factura.estatus, 'cancelada');
  });

  constructor() {
    void this.recargar();
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

  /** El mínimo de dos caracteres, como en las otras pantallas de listado. */
  private textoBusqueda(): string | undefined {
    const limpio = this.filtroTexto().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  cambiarEstatus(valor: string): void {
    this.filtroEstatus.set(valor as '' | EstatusFactura);
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

  /** Deja los filtros como estaban al entrar. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.filtroTexto.set('');
    this.filtroEstatus.set('');
    this.filtroDesde.set('');
    this.filtroHasta.set('');
    void this.recargar();
  }

  /**
   * Vuelve a la primera página con el filtro que se tenga puesto, y cierra el
   * comprobante: con filtros nuevos la factura abierta puede no estar en la
   * página, y un comprobante flotando sin su fila es peor que ninguno.
   */
  private async recargar(): Promise<void> {
    this.cerrarDetalle();
    await this.cargarPagina(1);
  }

  /** Carga una página. Es la ÚNICA forma de pedir el listado. */
  private async cargarPagina(pagina: number): Promise<void> {
    // La signal del estatus se lee UNA vez y a una variable: leída dos veces en
    // la misma expresión, TypeScript no la puede acotar y el filtro-empty se
    // cuela en el tipo del parámetro.
    const estatusElegido = this.filtroEstatus();
    this.cargando.set(true);
    this.errorLista.set(null);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        estatus: estatusElegido === '' ? undefined : estatusElegido,
        desde: this.filtroDesde() || undefined,
        hasta: this.filtroHasta() || undefined,
        limite: this.limite(),
        offset: (pagina - 1) * this.limite(),
      });
      this.filas.set(resultado.datos);
      this.recarga.marcar();
      this.totalEncontrado.set(resultado.total);
      this.pagina.set(pagina);

      // La fila desplegada puede no haber sobrevivido al filtro o a la página:
      // si ya no está en la tabla, su comprobante se cierra solo.
      const id = this.expandida();
      if (id !== null && !resultado.datos.some((factura) => factura.id === id)) {
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
    document.querySelector('.facturacion .tabla-wrapper')?.scrollIntoView({
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

  // --------------------------------------------------------------- la captura
  /** Abre la captura en blanco. */
  nueva(): void {
    this.cliente.set(null);
    this.notas.set([]);
    this.totalCandidatas.set(0);
    this.fecha.set('');
    this.metodoPago.set('');
    this.errorCaptura.set(null);
    this.buscadorCliente.limpiar();
    this.editorVisible.set(true);
  }

  /**
   * Abre o cierra la captura.
   *
   * Cerrarla con algo capturado pasa por el modal: si ya se eligió cliente, se
   * están buscando sus notas, perder eso tiene que ser una decisión y no un
   * clic.
   */
  async alternarEditor(): Promise<void> {
    if (this.editorVisible() && this.hayCaptura()) {
      const confirmado = await this.confirmModal().abrir({
        titulo: 'Descartar la captura',
        mensaje:
          'Esta factura está a medio armar y se va a perder. ¿Cerrar de todos modos?\n\nSi solo querías revisar la lista, ciérrala y vuelve a abrirla: la captura sigue en blanco.',
        textoConfirmar: 'Descartar y cerrar',
        variante: 'peligro',
      });
      if (!confirmado) return;

      this.descartarCaptura();
    }

    this.editorVisible.update((visible) => !visible);
  }

  /** Cierra la captura sin preguntar. Es lo que se usa al guardar bien. */
  private cerrarEditor(): void {
    this.descartarCaptura();
    this.editorVisible.set(false);
  }

  /** Vuelve la captura a blanco. */
  private descartarCaptura(): void {
    this.cliente.set(null);
    this.notas.set([]);
    this.totalCandidatas.set(0);
    this.fecha.set('');
    this.metodoPago.set('');
    this.errorCaptura.set(null);
    this.buscadorCliente.limpiar();
  }

  elegirCliente(cliente: { id: number; nombre: string }): void {
    this.cliente.set(cliente);
    this.notas.set([]);
    this.errorCaptura.set(null);
    void this.cargarNotas(cliente.id);
  }

  cambiarCliente(): void {
    this.cliente.set(null);
    this.notas.set([]);
    this.totalCandidatas.set(0);
    this.buscadorCliente.limpiar();
  }

  private async cargarNotas(clienteId: number): Promise<void> {
    this.cargandoNotas.set(true);
    try {
      const candidatas = await this.api.notasFacturables(clienteId);
      this.notas.set(candidatas.notas);
      this.totalCandidatas.set(candidatas.total);
    } catch (falla) {
      this.notas.set([]);
      this.totalCandidatas.set(0);
      this.errorCaptura.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoNotas.set(false);
    }
  }

  /** La casilla de la nota. Las marcadas son las que entran en la factura. */
  alternar(notaId: number): void {
    this.notas.update((notas) =>
      notas.map((n) => (n.nota_id === notaId ? { ...n, elegida: !n.elegida } : n)),
    );
  }

  /** Marca o desmarca todas las que hay. Para facturar un mes entero. */
  alternarTodas(): void {
    const todas = this.elegidas() === this.notas().length;
    this.notas.update((notas) => notas.map((n) => ({ ...n, elegida: !todas })));
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
      this.detalle.set(await this.api.obtener(id));
      this.expandida.set(id);
      this.pidiendoMotivo.set(false);
      this.motivo.set('');
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
   * Vuelve a la página 1 antes de desplegarlo, porque la factura recién hecha
   * es la más reciente y es donde tiene que estar. Si alguien capturó una
   * fecha vieja puede quedar fuera de la primera página, y en ese caso la fila
   * no está: por eso el aviso del botón dice "se generó", no "ya la estás
   * viendo".
   */
  async guardar(): Promise<void> {
    const cliente = this.cliente();
    if (cliente === null || !this.puedeGuardar()) return;

    this.guardando.set(true);
    this.errorCaptura.set(null);
    try {
      const factura = await this.api.crear(
        cuerpoDeFactura(cliente.id, this.fecha(), this.metodoPago(), this.notas()),
      );
      this.cerrarEditor();
      this.toast.exito(`Factura #${factura.id} generada con éxito`);

      await this.cargarPagina(1);
      // Se despliega lo que devolvió el alta, que ya trae las notas: pedir el
      // detalle otra vez sería una segunda ida al servidor por lo mismo.
      if (this.filas().some((otra) => otra.id === factura.id)) {
        this.detalle.set(factura);
        this.expandida.set(factura.id);
      }
    } catch (falla) {
      this.errorCaptura.set(this.explicar(falla));
    } finally {
      this.guardando.set(false);
    }
  }

  /** Marcar emitida. Sin motivo: el único que pide motivo es cancelar. */
  async marcarEmitida(): Promise<void> {
    await this.moverA('emitida', '');
  }

  cancelar(): void {
    this.motivo.set('');
    this.errorDetalle.set(null);
    this.pidiendoMotivo.set(true);
  }

  noCancelar(): void {
    this.pidiendoMotivo.set(false);
    this.motivo.set('');
  }

  async confirmarCancelacion(): Promise<void> {
    if (problemaDeMotivo(this.motivo()) !== null) return;
    await this.moverA('cancelada', this.motivo());
  }

  /**
   * Mueve el estatus y deja la fila abierta con el comprobante ya actualizado.
   *
   * El listado se recarga para que el badge cambie, pero NO se recoge el
   * comprobante: quien cancela necesita ver que la factura quedó cancelada y
   * con su motivo, y cerrarles la fila justo entonces es contraproducente.
   */
  private async moverA(estatus: EstatusFactura, motivo: string): Promise<void> {
    const factura = this.detalle();
    if (factura === null || this.cambiando()) return;

    this.cambiando.set(true);
    this.errorDetalle.set(null);
    try {
      const actualizada = await this.api.cambiarEstatus(
        factura.id,
        cuerpoDeEstatus(estatus, motivo),
      );
      this.detalle.set(actualizada);
      this.pidiendoMotivo.set(false);
      this.motivo.set('');
      this.toast.exito(
        estatus === 'emitida'
          ? `Factura #${actualizada.id} emitida`
          : `Factura #${actualizada.id} cancelada`,
      );
      await this.cargarPagina(this.pagina());
    } catch (falla) {
      this.errorDetalle.set(this.explicar(falla));
    } finally {
      this.cambiando.set(false);
    }
  }

  // ---------------------------------------------------------------- los errores
  /**
   * Los errores del servicio, traducidos para quien factura.
   *
   * Los tres de las notas son los que de verdad llegan: el listado de notas no
   * dice cuáles están ya facturadas, así que la pantalla las ofrece y quien
   * sabe es el servidor. El mensaje del backend ya trae el folio; lo que se
   * agrega es qué hacer —quitar la nota de la lista, o mirar la factura que la
   * tiene—. El 403 de `facturas.emitir` se traduce porque llega dicho en
   * términos de permisos, y aquí la acción es "preguntarle a quien sí puede".
   */
  private explicar(falla: unknown): string {
    const legible = errorLegible(falla);
    const datos = legible.datos as { folio?: string; factura_id?: number } | null;

    if (legible.codigo === 'PROHIBIDO' && legible.mensaje.includes('facturas.emitir')) {
      return 'Tu rol puede solicitar facturas pero no emitirlas ni cancelarlas: pídele a un administrador que la emita.';
    }
    if (legible.codigo === 'NOTA_YA_FACTURADA' && datos?.factura_id !== undefined) {
      return `La nota ${datos.folio ?? ''} ya está en la factura ${datos.factura_id}. Quítala de la lista si lo que quieres es hacer una nueva.`;
    }
    if (legible.codigo === 'NOTA_CANCELADA_NO_SE_FACTURA') {
      return `La nota ${datos?.folio ?? ''} se canceló mientras armabas la factura. Quítala de la lista.`;
    }
    return legible.mensaje;
  }

  // ----------------------------------------------------------------- el texto
  // Los símbolos que la plantilla usa como método de la clase.
  montoComoTexto = montoComoTexto;
  estatusComoTexto = estatusComoTexto;
  estatusNotaComoTexto = estatusNotaComoTexto;
  problemaDeMotivo = problemaDeMotivo;

  /**
   * La clase del badge de estatus.
   *
   * El estatus es la razón por la que se mira esta tabla —si lo que se emitió
   * ya está en manos del cliente o si se canceló— así que va en badge y no en
   * texto: "Cancelada" tiene que verse de un vistazo, y verde es exactamente
   * lo que NO es una factura cancelada.
   */
  claseDeEstatus(estatus: EstatusFactura): string {
    switch (estatus) {
      case 'emitida':
        return 'badge';
      case 'cancelada':
        return 'badge badge-apagado';
      default:
        return 'badge badge-neutro';
    }
  }

  /** La misma idea para el estatus de una NOTA, que es del POS y no de la factura. */
  claseDeNota(estatus: EstatusNota): string {
    switch (estatus) {
      case 'pagada':
        return 'badge';
      case 'cancelada':
        return 'badge badge-apagado';
      default:
        return 'badge badge-neutro';
    }
  }
}
