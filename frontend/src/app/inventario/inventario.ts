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
import { bultosComoTexto, decimalComoTexto } from '../nucleo/cifras';
import { Sesion } from '../nucleo/sesion';
import { ToastService } from '../nucleo/toast.service';
import { ConfirmModal } from '../productos/confirm-modal';
import {
  InventarioApi,
  type Existencia,
  type FiltroExistencia,
  type Movimiento,
} from './inventario-api';

/**
 * La pantalla de inventario.
 *
 * Misma estructura que clientes, proveedores, productos y el catálogo, y por
 * el mismo motivo: el diseño está en `nucleo/pantallas.scss` y aquí solo queda
 * lo que es de inventario.
 *
 * La existencia es por PRODUCTO y ALMACÉN, y en BULTOS. No es un campo que
 * alguien capture: es la suma de `inventario_movimientos`, y los movimientos
 * los escriben las notas de venta y las compras por trigger.
 *
 * Lo que esta pantalla SI escribe, a partir de ahora, son los movimientos
 * MANUALES: el botón "Ajustar" de un renglón abre el editor de ese producto en
 * ese almacén, registra ajustes y mermas (con su motivo obligatorio) y
 * muestra el KARDEX para poder borrar uno. El permiso es `inventario.ajustar`,
 * el mismo que la base pide, y cada alta o borrado queda en
 * `auditoria_inventario` con la existencia antes y después.
 *
 * El listado pagina de verdad (antes era "cargar más", que pegaba las
 * siguientes al final y con el cruce de productos por almacenes eran cuatro
 * pantallas de tabla).
 *
 * Dos cosas que la tabla sigue haciendo notar:
 *
 *   - Un producto que nunca se compró aparece en CERO, no desaparece: el
 *     backend cruza todos los productos con todos los almacenes.
 *   - El CERO y el NEGATIVO se pintan en rojo. El modelo permite vender sin
 *     existencia (avisa, no bloquea), así que un negativo es una deuda de
 *     mercancía que hay que ver.
 */

/** El renglón que se está ajustando, o `null` si el editor está cerrado. */
type TipoManual = 'ajuste_positivo' | 'ajuste_negativo' | 'merma';

@Component({
  selector: 'app-inventario',
  templateUrl: './inventario.html',
  styleUrl: './inventario.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [filasAnimation],
  imports: [ConfirmModal],
})
export class Inventario {
  private readonly api = inject(InventarioApi);
  private readonly sesion = inject(Sesion);
  private readonly toast = inject(ToastService);
  readonly confirmModal = viewChild.required(ConfirmModal);

  // ------------------------------------------------------------- el listado
  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  readonly filas = signal<Existencia[]>([]);
  readonly total = signal(0);
  readonly buscando = signal(false);
  readonly error = signal<string | null>(null);

  readonly buscador = signal('');
  readonly filtro = signal<FiltroExistencia>('todas');

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
    () => this.buscador().trim().length >= 2 || this.filtro() !== 'todas',
  );

  bultosComoTexto = bultosComoTexto;

  constructor() {
    void this.recargar();
  }

  // ------------------------------------------------------------- el listado

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /**
   * Busca con 250 ms de espera, igual que el resto de las pantallas.
   *
   * Cada tecleo NO pega una petición: con el buscador abierto a media
   * escritura son varias y la última es la única que sirve. Además, buscar
   * vuelve siempre a la página 1, porque quedarse en la 4 con un filtro nuevo
   * es mirar un `offset` que ya no quiere decir nada.
   */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  /** Cambia el filtro de existencia. También vuelve a la primera página. */
  cambiarFiltro(valor: string): void {
    this.filtro.set(valor as FiltroExistencia);
    void this.recargar();
  }

  /** Deja el buscador y el filtro como estaban al entrar. */
  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.buscador.set('');
    this.filtro.set('todas');
    void this.recargar();
  }

  /**
   * El texto de búsqueda, o `undefined` si es muy corto.
   *
   * El mínimo de dos caracteres es el de siempre: con uno solo, el `ILIKE` del
   * backend trae medio catálogo y la tabla deja de informar.
   */
  private textoBusqueda(): string | undefined {
    const limpio = this.buscador().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  /** Vuelve a la primera página con el filtro que se tenga puesto. */
  private async recargar(): Promise<void> {
    await this.cargarPagina(1);
  }

  /** Carga una página. Es la ÚNICA forma de pedir existencia. */
  private async cargarPagina(pagina: number): Promise<void> {
    this.buscando.set(true);
    this.error.set(null);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        existencia: this.filtro(),
        limite: this.limite(),
        offset: (pagina - 1) * this.limite(),
      });

      // La página pedida ya no existe (el filtro se narrowed entre una carga y
      // otra): se retrocede una en vez de dejar una tabla vacía con el
      // contador diciendo "página 7 de 7". Solo cuando hay páginas antes, por
      // que en la primera lo que hay que mostrar es el estado vacío.
      if (resultado.datos.length === 0 && pagina > 1) {
        await this.cargarPagina(pagina - 1);
        return;
      }

      this.filas.set(resultado.datos);
      this.recarga.marcar();
      this.total.set(resultado.total);
      this.pagina.set(pagina);
    } catch (falla) {
      this.filas.set([]);
      this.total.set(0);
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.buscando.set(false);
    }
  }

  /** Cambia de página y sube la tabla a la vista. */
  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;

    await this.cargarPagina(pagina);
    document.querySelector('.inventario .tabla-wrapper')?.scrollIntoView({
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
    // Vuelve SIEMPRE a la página 1: quedarse en la 7 y pasar de 25 a 50 filas
    // es pedir un `offset` que ya no corresponde a nada.
    void this.recargar();
  }

  /** Cero o negativo: lo que la tabla pinta en rojo. */
  sinExistencia(fila: Existencia): boolean {
    return fila.existencia_bultos <= 0;
  }

  // ------------------------------------------------- el editor de ajustes

  /** El permiso que pide la base para insertar o borrar un movimiento manual. */
  readonly puedeAjustar = computed(() => this.sesion.puede('inventario.ajustar'));

  /**
   * El renglón (producto + almacén) cuyo kardex se está viendo, o `null`.
   *
   * No es un editor "nuevo": un ajuste siempre es de UN producto en UN almacén
   * que ya existen en la tabla, así que este señal ES la combinación y el
   * formulario no necesita selectores de nada.
   */
  readonly editando = signal<Existencia | null>(null);

  readonly tipo = signal<TipoManual>('ajuste_positivo');
  readonly cantidad = signal('');
  readonly motivo = signal('');
  readonly guardando = signal(false);
  readonly errorEditor = signal<string | null>(null);

  /** El kardex del producto en el almacén, del más reciente al más viejo. */
  readonly movimientos = signal<Movimiento[]>([]);
  /** Cascada de entrada del kardex, aparte de la de la tabla grande. */
  readonly recargaKardex = new Recarga();
  readonly cargandoKardex = signal(false);
  readonly errorKardex = signal<string | null>(null);
  /** Hasta dónde se lee: son "los últimos" movimientos, no la eternidad. */
  readonly KARDEX_LIMITE = 100;

  readonly cantidadValida = computed(() => /^\d{1,10}(\.\d{1,2})?$/.test(this.cantidad().trim()));
  readonly motivoValido = computed(() => this.motivo().trim().length >= 3);
  readonly puedeRegistrar = computed(
    () =>
      this.puedeAjustar() &&
      !this.guardando() &&
      this.cantidadValida() &&
      this.motivoValido() &&
      this.editando() !== null,
  );

  /** Abre el editor del renglón y carga su kardex. */
  async ajustar(fila: Existencia): Promise<void> {
    if (!this.puedeAjustar()) return;
    this.editando.set(fila);
    this.tipo.set('ajuste_positivo');
    this.cantidad.set('');
    this.motivo.set('');
    this.errorEditor.set(null);
    await this.cargarKardex(fila);
  }

  /** Cierra el editor. La existencia de la tabla no cambió nada mientras se miraba. */
  cerrarEditor(): void {
    this.editando.set(null);
    this.movimientos.set([]);
    this.errorEditor.set(null);
    this.errorKardex.set(null);
  }

  /** El kardex del renglón actual. Se relee tras registrar o borrar. */
  private async cargarKardex(fila: Existencia): Promise<void> {
    this.cargandoKardex.set(true);
    this.errorKardex.set(null);
    try {
      const lista = await this.api.listarMovimientos({
        producto_id: fila.producto_id,
        almacen_id: fila.almacen_id,
        limite: this.KARDEX_LIMITE,
      });
      this.movimientos.set(lista.datos);
      this.recargaKardex.marcar();
    } catch (falla) {
      this.movimientos.set([]);
      this.errorKardex.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoKardex.set(false);
    }
  }

  cambiarTipo(valor: string): void {
    this.tipo.set(valor as TipoManual);
  }

  cambiarCantidad(texto: string): void {
    this.cantidad.set(texto);
  }

  cambiarMotivo(texto: string): void {
    this.motivo.set(texto);
  }

  /**
   * Registra el ajuste o la merma.
   *
   * El editor se queda abierto: quien está corrigiendo el kardex suele
   * registrar varios renglones del mismo producto (una merma y un ajuste en
   * la misma revisión), y obligar a cerrar y abrir entre uno y otro solo
   * gasta tiempo. La cantidad y el motivo se limpian para el siguiente.
   */
  async registrar(): Promise<void> {
    const fila = this.editando();
    if (fila === null || !this.puedeRegistrar()) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    try {
      let cantidad: string;
      try {
        cantidad = decimalComoTexto(this.cantidad(), 2);
      } catch {
        this.errorEditor.set('La cantidad debe ser un número con hasta 2 decimales.');
        return;
      }

      const creado = await this.api.crearMovimiento({
        producto_id: fila.producto_id,
        almacen_id: fila.almacen_id,
        tipo: this.tipo(),
        cantidad_bultos: cantidad,
        motivo: this.motivo().trim(),
      });

      this.toast.exito(
        `${this.etiquetaTipo(creado.tipo)}: ${bultosComoTexto(creado.cantidad_bultos)} bultos`,
      );
      this.cantidad.set('');
      this.motivo.set('');
      await this.recargarKardexYExistencia();
    } catch (falla) {
      this.errorEditor.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /** Borra un movimiento manual, con confirmación. */
  async eliminar(movimiento: Movimiento): Promise<void> {
    if (!movimiento.manual || !this.puedeAjustar() || this.guardando()) return;

    const confirmado = await this.confirmModal().abrir({
      titulo: 'Borrar el movimiento',
      mensaje: `Se borra el ${this.etiquetaTipo(movimiento.tipo).toLowerCase()} de ${bultosComoTexto(
        movimiento.cantidad_bultos,
      )} bultos y el stock de esa fila regresa. Queda en la bitácora.`,
      textoConfirmar: 'Borrar',
      variante: 'peligro',
    });
    if (!confirmado) return;

    this.guardando.set(true);
    this.errorEditor.set(null);
    try {
      await this.api.eliminarMovimiento(movimiento.id);
      this.toast.exito('Movimiento borrado y stock regresado');
      await this.recargarKardexYExistencia();
    } catch (falla) {
      this.errorEditor.set(errorLegible(falla).mensaje);
    } finally {
      this.guardando.set(false);
    }
  }

  /** El kardex cambió: se relee el kardex y la existencia de la tabla también. */
  private async recargarKardexYExistencia(): Promise<void> {
    const fila = this.editando();
    if (fila !== null) await this.cargarKardex(fila);
    await this.cargarPagina(this.pagina());
  }

  // ------------------------------------------------------------- el kardex

  /** +1 si el movimiento SUBE stock, -1 si lo baja. Es la firma del tipo. */
  firmaDe(tipo: Movimiento['tipo']): -1 | 1 {
    return tipo === 'entrada_compra' || tipo === 'ajuste_positivo' ? 1 : -1;
  }

  /** La cantidad del renglón, ya con su signo. Positivo se deja también con +. */
  cantidadConFirma(movimiento: Pick<Movimiento, 'tipo' | 'cantidad_bultos'>): number {
    return this.firmaDe(movimiento.tipo) * movimiento.cantidad_bultos;
  }

  /** Cómo se lee el tipo en la pantalla. */
  etiquetaTipo(tipo: Movimiento['tipo']): string {
    switch (tipo) {
      case 'entrada_compra':
        return 'Entrada (compra)';
      case 'salida_venta':
        return 'Salida (venta)';
      case 'ajuste_positivo':
        return 'Ajuste arriba';
      case 'ajuste_negativo':
        return 'Ajuste abajo';
      case 'merma':
        return 'Merma';
    }
  }

  /** "AAAA-MM-DDThh:mm" -> "AAAA-MM-DD hh:mm", que se lee igual en todo el país. */
  fechaDe(movimiento: Movimiento): string {
    return movimiento.fecha.replace('T', ' ');
  }
}
