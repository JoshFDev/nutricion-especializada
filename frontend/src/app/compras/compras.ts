import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorLegible } from '../nucleo/api';
import { crearBuscador } from '../nucleo/buscador';
import { Sesion } from '../nucleo/sesion';
import { bultosComoTexto, kilosComoTexto, montoComoTexto } from '../nucleo/cifras';
import {
  ComprasApi,
  cuerpoDeCompra,
  estatusComoTexto,
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
 * Tiene TRES vistas en un solo componente y no en tres rutas:
 *
 *   - **lista**: las compras con sus filtros, lo que se ve casi siempre.
 *   - **captura**: el alta de una compra, con el proveedor y los renglones.
 *   - **detalle**: la compra guardada, que es el comprobante y donde se
 *     cancela.
 *
 * El detalle NO es una ruta a proposito, por lo mismo que el comprobante del
 * POS: es el final de la captura, no otro lugar. Si fuera una ruta, recargar
 * dejaria a la persona en la pantalla de una compra que ya se guardo, sin
 * forma clara de volver.
 *
 * Tres decisiones que conviene tener presentes:
 *
 *   - **No hay editar.** Una compra se deshace CANCELANDOLA con un motivo, no
 *     editando renglones: editarlos dejaria el inventario con la entrada
 *     vieja y la nueva. La cancelacion la bloquea el backend si ya hay pagos
 *     (`COMPRA_CON_PAGO`), y la pantalla lo explica.
 *   - **No hay borrar.** Cancelar deja el documento con estatus 'cancelada' y
 *     devuelve los bultos a la bodega por trigger.
 *   - **El costo se puede dejar vacio.** Si no se escribe, lo resuelve el
 *     backend con el ultimo costo de ESE proveedor (`producto_proveedor_precios`),
 *     y por eso el total de la captura es un preview que avisa cuando hay
 *     renglones sin costo (ver `haySinCosto`).
 */
type Pantalla = 'lista' | 'captura' | 'detalle';

@Component({
  selector: 'app-compras',
  templateUrl: './compras.html',
  styleUrl: './compras.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Compras {
  private readonly api = inject(ComprasApi);
  private readonly sesion = inject(Sesion);

  readonly pantalla = signal<Pantalla>('lista');

  /** Cancelar pide `compras.crear` (asi lo exige el trigger de la base). */
  readonly puedeCrear = computed(() => this.sesion.puede('compras.crear'));

  // --------------------------------------------------------------- el listado
  readonly filas = signal<CompraListada[]>([]);
  readonly totalEncontrado = signal(0);
  readonly cargando = signal(false);
  readonly cargandoMas = signal(false);
  readonly errorLista = signal<string | null>(null);

  readonly filtroTexto = signal('');
  readonly filtroEstatus = signal<'todos' | EstatusCompra>('todos');
  readonly filtroDesde = signal('');
  readonly filtroHasta = signal('');
  readonly filtroProveedor = signal<ProveedorOpcion | null>(null);

  readonly hayMas = computed(() => this.filas().length < this.totalEncontrado());

  readonly buscadorFiltroProveedor = crearBuscador({
    cargar: (texto) => this.api.proveedores(texto),
    minimo: 2,
    nada: (texto) => `Ningún proveedor coincide con «${texto}».`,
    alElegir: (opcion) => this.elegirFiltroProveedor(opcion),
  });

  // --------------------------------------------------------------- la captura
  readonly proveedor = signal<ProveedorOpcion | null>(null);
  readonly fecha = signal('');
  readonly folio = signal('');
  readonly lineas = signal<LineaCompra[]>([]);
  readonly guardando = signal(false);
  readonly errorCaptura = signal<string | null>(null);

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

  readonly puedeGuardar = computed(
    () =>
      this.proveedor() !== null &&
      this.hayLineas() &&
      this.lineas().every(lineaValida) &&
      this.puedeCrear() &&
      !this.guardando(),
  );

  // --------------------------------------------------------------- el detalle
  readonly detalle = signal<Compra | null>(null);
  readonly errorDetalle = signal<string | null>(null);
  readonly cancelando = signal(false);
  /** El motivo se pide en la propia pantalla, no con un `prompt`. */
  readonly pidiendoMotivo = signal(false);
  readonly motivo = signal('');

  constructor() {
    void this.recargar();
  }

  // --------------------------------------------------------------- el listado
  private temporizador: ReturnType<typeof setTimeout> | undefined;

  /** Busca con 250 ms de espera, igual que el resto de las pantallas. */
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

  async recargar(): Promise<void> {
    this.cargando.set(true);
    this.errorLista.set(null);
    try {
      const resultado = await this.api.listar(this.filtros(0));
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
      const resultado = await this.api.listar(this.filtros(this.filas().length));
      this.filas.update((ya) => [...ya, ...resultado.datos]);
      this.totalEncontrado.set(resultado.total);
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
    } finally {
      this.cargandoMas.set(false);
    }
  }

  /** Los filtros comunes a la carga y a "cargar mas". */
  private filtros(offset: number): NonNullable<Parameters<ComprasApi['listar']>[0]> {
    const estatus = this.filtroEstatus();
    return {
      buscar: this.textoBusqueda(),
      proveedor_id: this.filtroProveedor()?.id,
      estatus: estatus === 'todos' ? undefined : estatus,
      desde: this.filtroDesde() || undefined,
      hasta: this.filtroHasta() || undefined,
      offset,
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
    this.pantalla.set('captura');
  }

  elegirProveedor(opcion: ProveedorOpcion): void {
    this.proveedor.set(opcion);
    this.errorCaptura.set(null);
  }

  /** Cambiar de proveedor no borra los renglones: compras no depende de el para el precio. */
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

  /** Vuelve a la lista; si hay renglones capturados, primero avisa. */
  volverALista(): void {
    if (this.hayLineas() && !confirmar('Se pierde la compra que llevas capturada.')) return;
    this.detalle.set(null);
    this.errorDetalle.set(null);
    this.pantalla.set('lista');
  }

  // --------------------------------------------------------------- el guardado
  async guardar(): Promise<void> {
    const proveedor = this.proveedor();
    if (proveedor === null || this.guardando()) return;

    this.guardando.set(true);
    this.errorCaptura.set(null);
    try {
      const compra = await this.api.crear(
        cuerpoDeCompra(proveedor.id, this.lineas(), this.folio(), this.fecha()),
      );
      this.detalle.set(compra);
      this.pantalla.set('detalle');
      await this.recargar();
    } catch (falla) {
      this.errorCaptura.set(this.explicar(falla));
    } finally {
      this.guardando.set(false);
    }
  }

  // --------------------------------------------------------------- el detalle
  async ver(id: number): Promise<void> {
    this.errorLista.set(null);
    try {
      this.detalle.set(await this.api.consultar(id));
      this.errorDetalle.set(null);
      this.motivo.set('');
      this.pidiendoMotivo.set(false);
      this.pantalla.set('detalle');
    } catch (falla) {
      this.errorLista.set(errorLegible(falla).mensaje);
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

  /** El motivo es obligatorio (minimo 3 letras en el backend). */
  readonly puedeCancelar = computed(() => this.motivo().trim().length >= 3 && !this.cancelando());

  async confirmarCancelacion(): Promise<void> {
    const compra = this.detalle();
    if (compra === null || !this.puedeCancelar()) return;

    this.cancelando.set(true);
    this.errorDetalle.set(null);
    try {
      this.detalle.set(await this.api.cancelar(compra.id, this.motivo()));
      this.pidiendoMotivo.set(false);
      this.motivo.set('');
      await this.recargar();
    } catch (falla) {
      this.errorDetalle.set(errorLegible(falla).mensaje);
    } finally {
      this.cancelando.set(false);
    }
  }

  /**
   * El error de guardar, en el idioma del que esta capturando.
   *
   * `SIN_COSTO` es el que vale la pena tratar: el mensaje del backend no dice
   * DE QUE producto, y la pantalla si lo sabe (esta en el renglon). Los otros
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
  // Los simbolos que la plantilla usa como metodo de la clase.
  estatusComoTexto = estatusComoTexto;
  montoComoTexto = montoComoTexto;
  kilosComoTexto = kilosComoTexto;
  bultosComoTexto = bultosComoTexto;
  kilosDeLinea = kilosDeLinea;
  montoDeLinea = montoDeLinea;
  problemasDeLinea = problemasDe;
  sinCostoEscrito = sinCostoEscrito;

  readonly totalComoTexto = computed(() => montoComoTexto(this.total()));
}

/**
 * `confirm` para la unica cosa que se pierde sin avisar. Va en un envoltorio
 * para que, si algun dia se cambia a un `dialog` propio, se cambie en un solo
 * lugar.
 */
function confirmar(pregunta: string): boolean {
  return window.confirm(pregunta);
}
