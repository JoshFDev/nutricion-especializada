import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { bultosComoTexto } from '../nucleo/cifras';
import { InventarioApi, type Existencia, type FiltroExistencia } from './inventario-api';

/**
 * La pantalla de inventario.
 *
 * Es de SOLO LECTURA, y no por falta de tiempo: ajustar y registrar merma
 * necesitan un motivo y dejan rastro en `auditoria_inventario`, asi que
 * quieren su propia pantalla. Aqui solo se mira la existencia.
 *
 * La existencia es por PRODUCTO y ALMACEN, y en BULTOS. No es un campo que
 * alguien capture: es la suma de `inventario_movimientos`, y los movimientos
 * los escriben las notas de venta y las compras por trigger. Por eso esta
 * pantalla no tiene boton de guardar.
 *
 * Dos cosas que la tabla hace notar:
 *
 *   - Un producto que nunca se compro aparece en CERO, no desaparece: el
 *     backend cruza todos los productos con todos los almacenes.
 *   - El CERO y el NEGATIVO se pintan en rojo. El modelo permite vender sin
 *     existencia (avisa, no bloquea), asi que un negativo es una deuda de
 *     mercancia que hay que ver.
 */
@Component({
  selector: 'app-inventario',
  templateUrl: './inventario.html',
  styleUrl: './inventario.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Inventario {
  private readonly api = inject(InventarioApi);

  readonly filas = signal<Existencia[]>([]);
  readonly totalEncontrado = signal(0);
  readonly cargando = signal(false);
  readonly cargandoMas = signal(false);
  readonly error = signal<string | null>(null);

  readonly buscador = signal('');
  readonly filtro = signal<FiltroExistencia>('todas');

  readonly hayMas = computed(() => this.filas().length < this.totalEncontrado());

  bultosComoTexto = bultosComoTexto;

  constructor() {
    void this.recargar();
  }

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /** Busca con 250 ms de espera, igual que el resto de las pantallas. */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  cambiarFiltro(valor: string): void {
    this.filtro.set(valor as FiltroExistencia);
    void this.recargar();
  }

  /**
   * El texto de busqueda, o `undefined` si es muy corto.
   *
   * El minimo de dos caracteres es el de siempre: con uno solo, el `ILIKE`
   * del backend trae medio catalogo y la tabla deja de informar.
   */
  private textoBusqueda(): string | undefined {
    const limpio = this.buscador().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  async recargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        existencia: this.filtro(),
      });
      this.filas.set(resultado.datos);
      this.totalEncontrado.set(resultado.total);
    } catch (falla) {
      this.filas.set([]);
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
    }
  }

  async cargarMas(): Promise<void> {
    if (!this.hayMas() || this.cargandoMas()) return;
    this.cargandoMas.set(true);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        existencia: this.filtro(),
        offset: this.filas().length,
      });
      this.filas.update((ya) => [...ya, ...resultado.datos]);
      this.totalEncontrado.set(resultado.total);
    } catch (falla) {
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoMas.set(false);
    }
  }

  /** Cero o negativo: lo que la tabla pinta en rojo. */
  sinExistencia(fila: Existencia): boolean {
    return fila.existencia_bultos <= 0;
  }
}
