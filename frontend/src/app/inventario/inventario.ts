import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { trigger, transition, style, animate, query, stagger } from '@angular/animations';
import { errorLegible } from '../nucleo/api';
import { bultosComoTexto } from '../nucleo/cifras';
import { InventarioApi, type Existencia, type FiltroExistencia } from './inventario-api';

/**
 * La pantalla de inventario.
 *
 * Misma estructura que clientes, proveedores, productos y el catálogo, y por
 * el mismo motivo: el diseño está en `nucleo/pantallas.scss` y aquí solo queda
 * lo que es de inventario. Lo único que NO trae es el editor, y es a
 * propósito: aquí no se captura nada.
 *
 * Es de SOLO LECTURA, y no por falta de tiempo: ajustar y registrar merma
 * necesitan un motivo y dejan rastro en `auditoria_inventario`, así que
 * quieren su propia pantalla. Por eso no hay botón de guardar.
 *
 * La existencia es por PRODUCTO y ALMACÉN, y en BULTOS. No es un campo que
 * alguien capture: es la suma de `inventario_movimientos`, y los movimientos
 * los escriben las notas de venta y las compras por trigger.
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

@Component({
  selector: 'app-inventario',
  templateUrl: './inventario.html',
  styleUrl: './inventario.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('filasAnimation', [
      transition('* => *', [
        query(
          ':enter',
          [
            style({ opacity: 0, transform: 'translateY(-10px)' }),
            stagger(50, [
              animate('300ms ease-out', style({ opacity: 1, transform: 'translateY(0)' })),
            ]),
          ],
          { optional: true },
        ),
        query(
          ':leave',
          [
            stagger(50, [
              animate('200ms ease-in', style({ opacity: 0, transform: 'translateX(20px)' })),
            ]),
          ],
          { optional: true },
        ),
      ]),
    ]),
  ],
})
export class Inventario {
  private readonly api = inject(InventarioApi);

  // ------------------------------------------------------------- el listado
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
}
