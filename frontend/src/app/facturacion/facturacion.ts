import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { crearBuscador } from '../nucleo/buscador';
import { Sesion } from '../nucleo/sesion';
import { montoComoTexto } from '../nucleo/cifras';
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
  type Factura,
  type FacturaListada,
  type NotaPorFacturar,
} from './facturacion-api';

/**
 * La pantalla de facturacion.
 *
 * Tres vistas en un solo componente, como compras:
 *
 *   - **lista**: las facturas con sus filtros.
 *   - **captura**: se elige el cliente, se marcan sus notas y se manda una
 *     factura que las cubre todas. El total que se ve es un preview: el que
 *     vale lo calcula el servidor sumando los subtotales, y por eso no se
 *     manda (`cuerpoDeFactura`).
 *   - **detalle**: la factura guardada, con las notas que cubre y los dos
 *     unicos movimientos que tiene: emitirla o cancelarla con motivo.
 *
 * Lo que la pantalla NO hace, a proposito:
 *
 *   - **No edita.** El unico PATCH del modulo es el del estatus, y el
 *     servicio tiene las transiciones escritas. Abrir un formulario de
 *     edicion dejaria que la pantalla inventara estados.
 *   - **No ofrece notas ya facturadas.** No se puede saber antes de preguntar
 *     (el listado de notas no trae ese dato), asi que se pide la factura y si
 *     el servidor dice que esa nota ya esta en otra, se explica cual. La
 *     pantalla no adivina: el unico que sabe que notas se han facturado es
 *     `factura_nota`, que es del servidor.
 *   - **No ofrece notas canceladas**, porque facturar mercancia que no salio
 *     es un CFDI que el SAT va a rechazar.
 *
 * Y los permisos van por separado, como en el servicio: `facturas.solicitar`
 * abre la pantalla y el boton de "Marcar emitida" y "Cancelar" pide
 * `facturas.emitir`. Si el rol no lo tiene, los botones no se ven en vez de
 * fallar al apretarlos.
 */
@Component({
  selector: 'app-facturacion',
  templateUrl: './facturacion.html',
  styleUrl: './facturacion.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Facturacion {
  private readonly api = inject(FacturacionApi);
  private readonly sesion = inject(Sesion);

  readonly pantalla = signal<'lista' | 'captura' | 'detalle'>('lista');

  /** Solicitar una factura: la pide cualquiera que facture. */
  readonly puedeSolicitar = computed(() => this.sesion.puede('facturas.solicitar'));
  /** Emitir el CFDI o cancelar la factura: el acto que no hace la cajera. */
  readonly puedeEmitir = computed(() => this.sesion.puede('facturas.emitir'));

  // --------------------------------------------------------------- el listado
  readonly filas = signal<FacturaListada[]>([]);
  readonly totalEncontrado = signal(0);
  readonly cargando = signal(false);
  readonly cargandoMas = signal(false);
  readonly errorLista = signal<string | null>(null);

  readonly filtroTexto = signal('');
  readonly filtroEstatus = signal<'' | EstatusFactura>('');
  readonly filtroDesde = signal('');
  readonly filtroHasta = signal('');

  readonly hayMas = computed(() => this.filas().length < this.totalEncontrado());
  private readonly limite = 50;

  // --------------------------------------------------------------- la captura
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
  readonly puedeGuardar = computed(
    () =>
      this.puedeSolicitar() &&
      this.cliente() !== null &&
      this.elegidas() > 0 &&
      !this.cargandoNotas() &&
      !this.guardando(),
  );

  readonly buscadorCliente = crearBuscador({
    cargar: (texto) => this.api.clientes(texto),
    minimo: 2,
    nada: (texto) => `Ningún cliente coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirCliente(opcion),
  });

  // --------------------------------------------------------------- el detalle
  readonly detalle = signal<Factura | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly cambiando = signal(false);
  /** El motivo se pide en la propia pantalla, no con un `prompt`. */
  readonly pidiendoMotivo = signal(false);
  readonly motivo = signal('');

  /** Emitir solo tiene sentido en una solicitada, y con el permiso de emitir. */
  readonly puedeEmitirFactura = computed(() => {
    const factura = this.detalle();
    return factura !== null && this.puedeEmitir() && puedePasarA(factura.estatus, 'emitida');
  });
  /** Cancelar es lo unico que hay desde emitida, y tambien pide el permiso. */
  readonly puedeCancelarFactura = computed(() => {
    const factura = this.detalle();
    return factura !== null && this.puedeEmitir() && puedePasarA(factura.estatus, 'cancelada');
  });

  constructor() {
    void this.recargar();
  }

  // --------------------------------------------------------------- el listado
  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /** Busca con 250 ms de espera, igual que las demas pantallas. */
  buscar(texto: string): void {
    clearTimeout(this.temporizador);
    this.filtroTexto.set(texto);
    this.temporizador = setTimeout(() => void this.recargar(), 250);
  }

  cambiarEstatus(valor: string): void {
    this.filtroEstatus.set(valor as '' | EstatusFactura);
    void this.recargar();
  }

  /**
   * El filtro de estatus ya limpio, para el `listar`.
   *
   * Se lee UNA vez a una variable porque TypeScript no estrecha una signal leida
   * dos veces: en `this.filtroEstatus() === '' ? undefined : this.filtroEstatus()`, la
   * segunda llamada vuelve a ser `'' | EstatusFactura` y el filtro se cuela como
   * texto vacio. Es el mismo truco de `pagos.ts` con el metodo.
   */
  private estatusPedido(): EstatusFactura | undefined {
    const actual = this.filtroEstatus();
    return actual === '' ? undefined : actual;
  }

  cambiarDesde(valor: string): void {
    this.filtroDesde.set(valor);
    void this.recargar();
  }

  cambiarHasta(valor: string): void {
    this.filtroHasta.set(valor);
    void this.recargar();
  }

  /** El minimo de dos caracteres, como en las otras pantallas de listado. */
  private textoBusqueda(): string | undefined {
    const limpio = this.filtroTexto().trim();
    return limpio.length >= 2 ? limpio : undefined;
  }

  async recargar(): Promise<void> {
    this.cargando.set(true);
    this.errorLista.set(null);
    try {
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        estatus: this.estatusPedido(),
        desde: this.filtroDesde() || undefined,
        hasta: this.filtroHasta() || undefined,
        limite: this.limite,
        offset: 0,
      });
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
      const resultado = await this.api.listar({
        buscar: this.textoBusqueda(),
        estatus: this.estatusPedido(),
        desde: this.filtroDesde() || undefined,
        hasta: this.filtroHasta() || undefined,
        limite: this.limite,
        offset: this.filas().length,
      });
      this.filas.update((ya) => [...ya, ...resultado.datos]);
      this.totalEncontrado.set(resultado.total);
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoMas.set(false);
    }
  }

  /** Vuelve al listado desde donde se este. */
  volverAlListado(): void {
    this.pantalla.set('lista');
    this.detalle.set(null);
    this.pidiendoMotivo.set(false);
    this.motivo.set('');
    void this.recargar();
  }

  // --------------------------------------------------------------- la captura
  abrirCaptura(): void {
    this.pantalla.set('captura');
    this.cliente.set(null);
    this.notas.set([]);
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
    this.buscadorCliente.limpiar();
  }

  private async cargarNotas(clienteId: number): Promise<void> {
    this.cargandoNotas.set(true);
    try {
      this.notas.set(await this.api.notasFacturables(clienteId));
    } catch (falla) {
      this.notas.set([]);
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

  async guardar(): Promise<void> {
    const cliente = this.cliente();
    if (cliente === null || !this.puedeGuardar()) return;

    this.guardando.set(true);
    this.errorCaptura.set(null);
    try {
      const cuerpo = cuerpoDeFactura(cliente.id, this.fecha(), this.metodoPago(), this.notas());
      const factura = await this.api.crear(cuerpo);
      this.pantalla.set('detalle');
      this.detalle.set(factura);
      this.pidiendoMotivo.set(false);
      this.motivo.set('');
      this.errorDetalle.set(null);
    } catch (falla) {
      this.errorCaptura.set(this.explicar(falla));
    } finally {
      this.guardando.set(false);
    }
  }

  // --------------------------------------------------------------- el detalle
  async ver(factura: FacturaListada): Promise<void> {
    this.cargandoDetalle.set(true);
    this.errorDetalle.set(null);
    this.pantalla.set('detalle');
    this.detalle.set(null);
    this.pidiendoMotivo.set(false);
    this.motivo.set('');
    try {
      this.detalle.set(await this.api.obtener(factura.id));
    } catch (falla) {
      this.errorDetalle.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoDetalle.set(false);
    }
  }

  /** Marcar emitida. Sin motivo: el unico que pide motivo es cancelar. */
  async marcarEmitida(): Promise<void> {
    await this.moverA('emitida', '');
  }

  cancelar(): void {
    this.pidiendoMotivo.set(true);
    this.motivo.set('');
  }

  async confirmarCancelacion(): Promise<void> {
    if (problemaDeMotivo(this.motivo()) !== null) return;
    await this.moverA('cancelada', this.motivo());
  }

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
   * dice cuales estan ya facturadas, asi que la pantalla las ofrece y quien
   * sabe es el servidor. El mensaje del backend ya trae el folio; lo que se
   * agrega es que hacer —quitar la nota de la lista, o mirar la factura que la
   * tiene—. El 403 de `facturas.emitir` se traduce porque llega dicho en
   * terminos de permisos, y aqui la accion es "preguntarle a quien si puede".
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

  // ------------------------------------------------------------------ atajos
  montoComoTexto = montoComoTexto;
  estatusComoTexto = estatusComoTexto;
  estatusNotaComoTexto = estatusNotaComoTexto;
  problemaDeMotivo = problemaDeMotivo;
}
