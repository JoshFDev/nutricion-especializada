import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { filasAnimation, Recarga } from '../nucleo/animaciones';
import { errorLegible } from '../nucleo/api';
import { montoComoTexto } from '../nucleo/cifras';
import { ToastService } from '../nucleo/toast.service';
import { EstadoCuentaApi, type RenglonEstadoCuenta } from './estado-cuenta-api';

/**
 * La pantalla de estado de cuenta: la lista de clientes con su saldo y un
 * boton para bajar la hoja de cada uno.
 *
 * Sustituye a Facturacion en el grupo Dinero del menu, y no es un cambio de
 * nombre: facturar y cobrar no son lo mismo. Aqui se ve quien debe, y se baja
 * el papel con el que se va a cobrar, con la misma plantilla que el negocio ya
 * usaba a mano.
 *
 * Es de SOLO LECTURA: lo que se ve lo calcula la base con las ventas
 * (`notas_remision`) y los abonos (`pagos`), y la unica accion es descargar.
 * El boton "Ver" NO abre nada en pantalla: baja el Excel, que es donde el
 * negocio anota a mano el mes en curso.
 *
 * El saldo POSITIVO (el cliente debe) va marcado para recorrer la lista de un
 * vistazo buscando a quien cobrar; el saldo a favor (negativo) es lo raro y va
 * en verde. Es el mismo criterio que el reporte del mismo nombre.
 */
@Component({
  selector: 'app-estado-cuenta',
  templateUrl: './estado-cuenta.html',
  styleUrl: './estado-cuenta.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [filasAnimation],
})
export class EstadoCuenta {
  private readonly api = inject(EstadoCuentaApi);
  private readonly avisos = inject(ToastService);

  // ------------------------------------------------------------------ filtros
  readonly buscador = signal('');
  readonly soloConSaldo = signal(false);

  /** Con dos caracteres o con la bandera encendida aparece el boton "Limpiar". */
  readonly hayFiltros = computed(() => this.buscador().trim().length >= 2 || this.soloConSaldo());

  // ------------------------------------------------------------------ listado
  readonly filas = signal<RenglonEstadoCuenta[]>([]);
  readonly total = signal(0);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  /** El cliente del que se esta bajando la hoja, para no disparar dos veces. */
  readonly bajando = signal<number | null>(null);

  /** Paginacion, igual que en el resto de los listados. */
  readonly limite = signal(25);
  readonly pagina = signal(1);

  readonly paginasTotales = computed(() => Math.max(1, Math.ceil(this.total() / this.limite())));
  readonly hayPaginaAnterior = computed(() => this.pagina() > 1);
  readonly hayPaginaSiguiente = computed(() => this.pagina() < this.paginasTotales());
  readonly rangoDePagina = computed(() => {
    const total = this.total();
    if (total === 0) return '0 de 0';
    const desde = (this.pagina() - 1) * this.limite() + 1;
    const hasta = Math.min(this.pagina() * this.limite(), total);
    return `${desde}-${hasta} de ${total}`;
  });

  /** Para la cascada de entrada de la tabla. Ver `nucleo/animaciones.ts`. */
  readonly recarga = new Recarga();

  /** Funcion pura, para usarla en la plantilla sin `this`. */
  montoComoTexto = montoComoTexto;

  /** La fecha de una venta o un pago, o un guion si nunca ocurrio. */
  fecha(fecha: string | null): string {
    return fecha ?? '—';
  }

  constructor() {
    void this.cargarPagina(1);
  }

  // ------------------------------------------------------------------ filtros

  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /** Busca con 250 ms de espera, como el resto de las pantallas. */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.buscador.set(texto);
    this.temporizador = setTimeout(() => void this.cargarPagina(1), 250);
  }

  toggleSoloConSaldo(): void {
    this.soloConSaldo.update((valor) => !valor);
    void this.cargarPagina(1);
  }

  limpiarFiltros(): void {
    clearTimeout(this.temporizador);
    this.buscador.set('');
    this.soloConSaldo.set(false);
    void this.cargarPagina(1);
  }

  private textoBusqueda(): string | undefined {
    const limpio = this.buscador().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  /** El tamano de pagina como texto, para el `[value]` del desplegable. */
  limiteComoTexto(): string {
    return String(this.limite());
  }

  async aTamanoDePagina(valor: string): Promise<void> {
    const limite = Number(valor);
    if (!Number.isFinite(limite) || limite <= 0 || limite === this.limite()) return;
    this.limite.set(limite);
    await this.cargarPagina(1);
  }

  async irPagina(pagina: number): Promise<void> {
    if (pagina < 1 || pagina > this.paginasTotales() || pagina === this.pagina()) return;
    await this.cargarPagina(pagina);
  }

  // ------------------------------------------------------------------ la hoja

  /**
   * Baja la hoja de estado de cuenta del cliente.
   *
   * La plantilla solo trae 20 movimientos: si la cuenta lleva mas, el Excel
   * sale con los primeros 20 y aqui se avisa cuantos quedaron fuera, para que
   * no se entregue un estado de cuenta a medias como si estuviera completo.
   */
  async ver(cliente: RenglonEstadoCuenta): Promise<void> {
    if (this.bajando() !== null) return;
    this.bajando.set(cliente.cliente_id);
    try {
      const fuera = await this.api.abrirHoja(cliente.cliente_id);
      if (fuera > 0) {
        this.avisos.advertencia(
          `La cuenta de ${cliente.cliente} tiene ${fuera} movimiento${fuera === 1 ? '' : 's'} de mas para la hoja: el Excel va con los primeros 20.`,
        );
      }
    } catch (falla) {
      this.avisos.error(errorLegible(falla).mensaje);
    } finally {
      this.bajando.set(null);
    }
  }

  // ------------------------------------------------------------------ el listado

  private async cargarPagina(pagina: number): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      const r = await this.api.listar({
        buscar: this.textoBusqueda(),
        solo_con_saldo: this.soloConSaldo(),
        limite: this.limite(),
        offset: (pagina - 1) * this.limite(),
      });
      this.filas.set(r.datos);
      this.total.set(r.total);
      this.pagina.set(pagina);
    } catch (falla) {
      this.filas.set([]);
      this.total.set(0);
      this.error.set(errorLegible(falla).mensaje);
    } finally {
      this.cargando.set(false);
      // Aqui y no dentro del `try`: la cascada avisa de que la tabla se
      // repinto, tanto si la respuesta llego como si fallo.
      this.recarga.marcar();
    }
  }
}
